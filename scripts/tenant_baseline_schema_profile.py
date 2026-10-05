"""Code-reviewed executable schema for the empty SpeedFeast baseline.

This is not a SQL sandbox or an approval. The complete archive/manifest hashes
must still be independently approved before any restore. Never infer permission
from a manifest-supplied function name or hash alone.
"""
from __future__ import annotations

import hashlib
import re

PROFILE = "speedfeast-empty-schema/2026-10-05/v1"
PROGRAMS = {
    "EXTENSION uuid-ossp": '''CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;''',
    "FUNCTION public.default_saas_instance_id()": '''CREATE FUNCTION public.default_saas_instance_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  SELECT instance_id
  FROM public.saas_instances
  WHERE singleton_key = TRUE
  LIMIT 1
$$;''',
    "FUNCTION public.default_store_id()": '''CREATE FUNCTION public.default_store_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  SELECT store_id
  FROM public.stores
  ORDER BY
    (status = 'active' AND is_default = TRUE) DESC,
    (status = 'active') DESC,
    is_default DESC,
    created_at,
    store_id
  LIMIT 1
$$;''',
    "FUNCTION public.refresh_cart_subtotal(uuid)": '''CREATE FUNCTION public.refresh_cart_subtotal(target_cart_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE public.cart
  SET subtotal_snapshot = COALESCE((
    SELECT SUM(line_subtotal)
    FROM public.cartitem
    WHERE cart_id = target_cart_id
  ), 0)
  WHERE cart_id = target_cart_id;
END;
$$;''',
    "FUNCTION public.refresh_cart_subtotal_trigger()": '''CREATE FUNCTION public.refresh_cart_subtotal_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.refresh_cart_subtotal(OLD.cart_id);
    RETURN OLD;
  END IF;

  PERFORM public.refresh_cart_subtotal(NEW.cart_id);
  IF TG_OP = 'UPDATE' AND OLD.cart_id <> NEW.cart_id THEN
    PERFORM public.refresh_cart_subtotal(OLD.cart_id);
  END IF;
  RETURN NEW;
END;
$$;''',
    "FUNCTION public.set_updated_at()": '''CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;''',
    "TRIGGER public.cart.trg_cart_set_updated_at": "CREATE TRIGGER trg_cart_set_updated_at BEFORE UPDATE ON public.cart FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();",
    "TRIGGER public.cartitem.trg_cartitem_refresh_cart_subtotal": "CREATE TRIGGER trg_cartitem_refresh_cart_subtotal AFTER INSERT OR DELETE OR UPDATE ON public.cartitem FOR EACH ROW EXECUTE FUNCTION public.refresh_cart_subtotal_trigger();",
    "TRIGGER public.cartitem.trg_cartitem_set_updated_at": "CREATE TRIGGER trg_cartitem_set_updated_at BEFORE UPDATE ON public.cartitem FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();",
    "TRIGGER public.system_config.trg_system_config_set_updated_at": "CREATE TRIGGER trg_system_config_set_updated_at BEFORE UPDATE ON public.system_config FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();",
}
REQUIRED_TABLES = frozenset({"cart", "cartitem", "system_config", "stores", "saas_instances"})
HEADER = re.compile(r"^--\n-- Name: (.+?); Type: (.+?); Schema: (.+?); Owner: -\n--\n", re.MULTILINE)
TABLE_SETTINGS = "SET default_tablespace = '';\n\nSET default_table_access_method = heap;"


def validate_program_sql(sql: str) -> dict[str, str]:
    """Compare complete executable object blocks, not substrings or TOC names."""
    if not isinstance(sql, str) or len(sql.encode("utf-8")) > 8_000_000 or "\x00" in sql:
        raise ValueError("Profile requires bounded offline schema SQL")
    sql = sql.replace("\r\n", "\n")
    headers = list(HEADER.finditer(sql))
    observed = {}
    for index, header in enumerate(headers):
        name, descriptor, schema = header.groups()
        if descriptor not in {"EXTENSION", "FUNCTION", "TRIGGER"}:
            continue
        if descriptor == "EXTENSION":
            key = f"EXTENSION {name}" if schema == "-" else "invalid extension schema"
        elif descriptor == "TRIGGER":
            key = f"TRIGGER {schema}.{name.replace(' ', '.')}"
        else:
            key = f"FUNCTION {schema}.{name}"
        if key not in PROGRAMS or key in observed:
            raise ValueError("Profile SQL contains an unknown or duplicate executable object")
        end = headers[index + 1].start() if index + 1 < len(headers) else len(sql)
        definition = sql[header.end():end].strip()
        # pg_restore appends these two non-executable table defaults before the
        # first TABLE block. No arbitrary trailing statement is stripped.
        if descriptor == "FUNCTION" and definition.endswith(TABLE_SETTINGS):
            definition = definition[:-len(TABLE_SETTINGS)].strip()
        if definition != PROGRAMS[key]:
            raise ValueError("Profile executable definition differs from reviewed code")
        observed[key] = hashlib.sha256(definition.encode("utf-8")).hexdigest()
    if observed.keys() != PROGRAMS.keys():
        raise ValueError("Profile SQL is missing required executable objects")
    return observed


def render_profile_verification_sql() -> str:
    """Verify installed extension, invoker functions and enabled triggers."""
    def literal(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"

    statements = [
        "DO $speedfeast_verify_profile$\nBEGIN\n",
        "  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='uuid-ossp' AND e.extversion='1.1' AND n.nspname='public') THEN\n",
        "    RAISE EXCEPTION 'Schema profile extension mismatch';\n  END IF;\n",
    ]
    for key, definition in PROGRAMS.items():
        if key.startswith("FUNCTION "):
            signature = key.removeprefix("FUNCTION public.")
            name, args = signature[:-1].split("(")
            body = definition.split("AS $$", 1)[1].removesuffix("$$;")
            language = "sql" if "LANGUAGE sql" in definition else "plpgsql"
            volatility = "s" if "LANGUAGE sql STABLE" in definition else "v"
            returns = re.search(r"RETURNS (\w+)", definition).group(1)
            statements.extend([
                "  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang\n",
                f"    WHERE n.nspname='public' AND p.proname={literal(name)} AND pg_catalog.oidvectortypes(p.proargtypes)={literal(args)}\n",
                f"    AND p.prorettype='pg_catalog.{returns}'::pg_catalog.regtype AND p.prosrc={literal(body)} AND l.lanname={literal(language)} AND p.provolatile={literal(volatility)}\n",
                "    AND NOT p.prosecdef AND p.proconfig IS NULL) THEN\n",
                "    RAISE EXCEPTION 'Schema profile function mismatch';\n  END IF;\n",
            ])
        elif key.startswith("TRIGGER "):
            schema, table, name = key.removeprefix("TRIGGER ").split(".")
            function = re.search(r"EXECUTE FUNCTION public\.(\w+)\(\)", definition).group(1)
            # PostgreSQL tgtype bitmask: ROW=1, BEFORE=2, INSERT=4,
            # DELETE=8, UPDATE=16. Exact reviewed trigger definitions only.
            trigger_type = 19 if "BEFORE UPDATE" in definition else 29
            statements.extend([
                "  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace\n",
                f"    WHERE n.nspname={literal(schema)} AND c.relname={literal(table)} AND t.tgname={literal(name)} AND t.tgtype={trigger_type}\n",
                f"    AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgnargs=0 AND pn.nspname='public' AND p.proname={literal(function)}) THEN\n",
                "    RAISE EXCEPTION 'Schema profile trigger mismatch';\n  END IF;\n",
            ])
    statements.append("END\n$speedfeast_verify_profile$;\n")
    return "".join(statements)
