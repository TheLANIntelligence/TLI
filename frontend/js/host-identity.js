/* Identity of the connected host only; this never selects a tool's target. */
(function (root, factory) {
  const create = factory();
  if (typeof module === 'object' && module.exports) module.exports = {create};
  else root.TLIHostIdentity = create(state => root.dispatchEvent(new CustomEvent('tli:host-identity', {detail: state})));
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  return function create(publish = () => {}, clock = Date.now) {
    let generation = 0, locked = false, identity = null;
    const rank = source => source === 'status' ? 1 : 2;
    const clean = value => typeof value === 'string' && value.trim().length <= 160 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '';
    // Saved names can predate the current write limit; keep them reviewable.
    const cleanName = value => typeof value === 'string' && Array.from(value).length <= 4096 && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value.trim() : '';
    const get = () => identity ? {...identity, generation, status: 'known'} : {id: null, name: null, observedAt: null, source: null, generation, status: locked ? 'locked' : 'unknown'};
    function observe(record) {
      if (locked || !record || (record.generation !== undefined && record.generation !== generation)) return false;
      const name = cleanName(record.name), id = clean(record.id) || null, source = record.source;
      const confirmedRename = source === 'host-rename' && id !== null;
      if (!name || (!confirmedRename && /^(?:[-—…]+|unknown|not confirmed|checking[. …]*|connecting[. …]*|tli node)$/i.test(name))) return false;
      if (!['status', 'dashboard/command-center', 'host-rename'].includes(source)) return false;
      const observedAt = record.observedAt ?? clock();
      if (!Number.isFinite(observedAt) || observedAt <= 0 || observedAt > clock() + 30000) return false;
      if (identity) {
        if (observedAt < identity.observedAt) return false;
        // A delayed/general status reply must not rename or retarget an explicit host.
        if (rank(source) < rank(identity.source) && (name !== identity.name || (id && identity.id && id !== identity.id))) return false;
      }
      const authority = identity && rank(identity.source) > rank(source) ? identity.source : source;
      identity = {id: id || (identity?.name === name ? identity.id : null), name, observedAt, source: authority};
      publish(get());
      return true;
    }
    function clear() { identity = null; generation++; publish(get()); }
    function setLocked(value) { const next = value === true; if (next === locked) return; locked = next; clear(); }
    return {get, observe, clear, setLocked};
  };
});
