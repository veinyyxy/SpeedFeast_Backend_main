BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DO $$
DECLARE
  product_images_exists boolean;
  product_images_legacy_exists boolean;
  product_images_has_asset_id boolean;
BEGIN
  SELECT to_regclass('public.product_images') IS NOT NULL
    INTO product_images_exists;

  SELECT to_regclass('public.product_images_legacy') IS NOT NULL
    INTO product_images_legacy_exists;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'product_images'
      AND column_name = 'asset_id'
  ) INTO product_images_has_asset_id;

  IF product_images_exists AND NOT product_images_has_asset_id THEN
    IF product_images_legacy_exists THEN
      RAISE EXCEPTION
        'Cannot migrate product_images: public.product_images_legacy already exists.';
    END IF;

    ALTER TABLE public.product_images RENAME TO product_images_legacy;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_images_pkey'
      AND conrelid = to_regclass('public.product_images_legacy')
  ) THEN
    ALTER TABLE public.product_images_legacy
      RENAME CONSTRAINT product_images_pkey TO product_images_legacy_pkey;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_images_product_id_fkey'
      AND conrelid = to_regclass('public.product_images_legacy')
  ) THEN
    ALTER TABLE public.product_images_legacy
      RENAME CONSTRAINT product_images_product_id_fkey
      TO product_images_legacy_product_id_fkey;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.media_assets (
  asset_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  asset_type text NOT NULL DEFAULT 'image',
  storage_provider text NOT NULL DEFAULT 'local',
  bucket text,
  object_key text,
  public_url text NOT NULL,
  variants jsonb NOT NULL DEFAULT '{}'::jsonb,
  mime_type text,
  width integer,
  height integer,
  size_bytes bigint,
  checksum_sha256 text,
  original_filename text,
  status text NOT NULL DEFAULT 'ready',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT media_assets_width_positive CHECK (width IS NULL OR width > 0),
  CONSTRAINT media_assets_height_positive CHECK (height IS NULL OR height > 0),
  CONSTRAINT media_assets_size_non_negative CHECK (
    size_bytes IS NULL OR size_bytes >= 0
  )
);

CREATE TABLE IF NOT EXISTS public.product_images (
  image_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id uuid NOT NULL REFERENCES public.products(product_id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES public.media_assets(asset_id),
  alt_text text,
  sort_order integer NOT NULL DEFAULT 0,
  is_primary boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF to_regclass('public.product_images_legacy') IS NOT NULL THEN
    INSERT INTO public.media_assets (
      storage_provider,
      object_key,
      public_url,
      variants,
      metadata
    )
    SELECT
      CASE
        WHEN legacy.image_url ~* '^https?://' THEN 'external'
        ELSE 'local'
      END AS storage_provider,
      CASE
        WHEN legacy.image_url ~* '^https?://[^/]+/'
          THEN regexp_replace(legacy.image_url, '^https?://[^/]+/', '')
        WHEN legacy.image_url LIKE '/%'
          THEN ltrim(legacy.image_url, '/')
        ELSE legacy.image_url
      END AS object_key,
      legacy.image_url AS public_url,
      jsonb_build_object('original', legacy.image_url) AS variants,
      jsonb_build_object(
        'migrated_from',
        'product_images_legacy',
        'legacy_image_ids',
        jsonb_agg(legacy.image_id ORDER BY legacy.image_id)
      ) AS metadata
    FROM public.product_images_legacy legacy
    WHERE legacy.image_url IS NOT NULL
      AND btrim(legacy.image_url::text) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM public.media_assets existing
        WHERE existing.public_url = legacy.image_url
          AND existing.deleted_at IS NULL
      )
    GROUP BY legacy.image_url;

    INSERT INTO public.product_images (
      product_id,
      asset_id,
      sort_order,
      is_primary,
      metadata
    )
    SELECT
      legacy.product_id,
      asset.asset_id,
      COALESCE(legacy.sort_order, 0),
      COALESCE(legacy.is_primary, false),
      jsonb_build_object(
        'migrated_from',
        'product_images_legacy',
        'legacy_image_id',
        legacy.image_id
      )
    FROM public.product_images_legacy legacy
    JOIN LATERAL (
      SELECT media.asset_id
      FROM public.media_assets media
      WHERE media.public_url = legacy.image_url
        AND media.deleted_at IS NULL
      ORDER BY media.created_at ASC, media.asset_id ASC
      LIMIT 1
    ) asset ON TRUE
    WHERE legacy.product_id IS NOT NULL
      AND legacy.image_url IS NOT NULL
      AND btrim(legacy.image_url::text) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM public.product_images existing
        WHERE existing.metadata->>'migrated_from' = 'product_images_legacy'
          AND existing.metadata->>'legacy_image_id' = legacy.image_id::text
      );
  END IF;
END
$$;

WITH ranked_primary_images AS (
  SELECT
    image_id,
    row_number() OVER (
      PARTITION BY product_id
      ORDER BY sort_order ASC, created_at ASC, image_id ASC
    ) AS primary_rank
  FROM public.product_images
  WHERE is_primary = TRUE
)
UPDATE public.product_images image
SET is_primary = FALSE,
    updated_at = now()
FROM ranked_primary_images ranked
WHERE image.image_id = ranked.image_id
  AND ranked.primary_rank > 1;

CREATE INDEX IF NOT EXISTS idx_media_assets_provider_key
  ON public.media_assets(storage_provider, bucket, object_key);

CREATE INDEX IF NOT EXISTS idx_media_assets_public_url
  ON public.media_assets(public_url);

CREATE INDEX IF NOT EXISTS idx_media_assets_status
  ON public.media_assets(status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_product_images_product_id
  ON public.product_images(product_id);

CREATE INDEX IF NOT EXISTS idx_product_images_asset_id
  ON public.product_images(asset_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_images_one_primary
  ON public.product_images(product_id)
  WHERE is_primary = TRUE;

COMMIT;
