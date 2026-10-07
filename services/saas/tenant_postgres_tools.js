// Windows EDB and the pinned Debian image report the same exact PostgreSQL
// patch with different packaging suffixes. Do not accept another patch/family.
function isPgRestore16_14(value){
  return typeof value==='string'&&/^pg_restore \(PostgreSQL\) 16\.14(?: \(Debian 16\.14-[0-9]+\.pgdg(?:12|13)(?:0)?\+[0-9]+\))?$/.test(value.trim());
}
module.exports={isPgRestore16_14};
