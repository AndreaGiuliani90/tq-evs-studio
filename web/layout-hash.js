// Impronta della pianta dell'ufficio (stanza, postazioni, arredi): se cambia, lo sfondo dipinto non corrisponde più.
// Usata sia dal browser sia dal server: deve restare identica nei due posti.
export function layoutHash(layout) {
  if (!layout) return '';
  const pick = { room: layout.room, stations: layout.stations, decor: layout.decor };
  const str = JSON.stringify(pick, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
