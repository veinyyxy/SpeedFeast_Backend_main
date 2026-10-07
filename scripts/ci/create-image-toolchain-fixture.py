"""Synthetic, schema-only CI fixture. Never reads a source DB or private dump."""
from __future__ import annotations
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from tenant_baseline_schema_profile import PROGRAMS

TABLE_SQL = """CREATE TABLE public.saas_instances(instance_id uuid, singleton_key boolean);
CREATE TABLE public.stores(store_id uuid, status text, is_default boolean, created_at timestamptz);
CREATE TABLE public.cart(cart_id uuid PRIMARY KEY, subtotal_snapshot numeric, updated_at timestamptz);
CREATE TABLE public.cartitem(cart_id uuid REFERENCES public.cart(cart_id), line_subtotal numeric, updated_at timestamptz);
CREATE TABLE public.system_config(updated_at timestamptz);
"""

def fixture_sql() -> str:
    return (PROGRAMS["EXTENSION uuid-ossp"] + "\n" + TABLE_SQL + "\n".join(
        value for name, value in PROGRAMS.items() if name.startswith("FUNCTION ")
    ) + "\n" + "\n".join(value for name, value in PROGRAMS.items() if name.startswith("TRIGGER ")) + "\n")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Expected one fresh fixture SQL output file")
    with pathlib.Path(sys.argv[1]).open("x", encoding="utf-8", newline="\n") as output:
        output.write(fixture_sql())
