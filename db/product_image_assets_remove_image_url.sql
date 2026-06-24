BEGIN;

DO $$
BEGIN
  IF to_regclass('public.media_assets') IS NULL THEN
    RAISE EXCEPTION 'Cannot remove product_images.image_url: public.media_assets does not exist.';
  END IF;

  IF to_regclass('public.product_images') IS NULL THEN
    RAISE EXCEPTION 'Cannot remove product_images.image_url: public.product_images does not exist.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'product_images'
      AND column_name = 'asset_id'
  ) THEN
    RAISE EXCEPTION 'Cannot remove product_images.image_url: product_images.asset_id does not exist.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_images
    WHERE asset_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot remove product_images.image_url: product_images contains rows with null asset_id.';
  END IF;
END
$$;

ALTER TABLE public.product_images
  ALTER COLUMN asset_id SET NOT NULL;

ALTER TABLE public.product_images
  DROP COLUMN IF EXISTS image_url;

COMMIT;
