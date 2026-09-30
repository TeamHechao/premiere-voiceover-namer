// UXP exposes distinct wrappers: only ProjectItem owns getId(). FolderItem
// owns getItems(), and ClipProjectItem owns the media methods. Keep casts
// strict so tests cannot accidentally accept a method on the wrong wrapper.
function createItemViews() {
  const bases = new WeakMap();
  const wrappers = new WeakMap();
  const kinds = new WeakMap();

  function register(wrapper, id, kind = typeof wrapper.getItems === 'function' ? 'folder' : 'clip') {
    const raw = {
      getId() { return id; },
      get name() { return wrapper.name; },
    };
    bases.set(wrapper, raw);
    wrappers.set(raw, wrapper);
    kinds.set(wrapper, kind);
    return wrapper;
  }
  function base(wrapper) {
    const raw = bases.get(wrapper);
    if (!raw) throw new Error('Expected a FolderItem or ClipProjectItem wrapper');
    return raw;
  }
  function fromBase(raw) {
    const wrapper = wrappers.get(raw);
    if (!wrapper) throw new Error('Expected a ProjectItem wrapper');
    return wrapper;
  }
  const ppro = {
    ProjectItem: { cast: base },
    FolderItem: { cast(raw) {
      const wrapper = fromBase(raw);
      return kinds.get(wrapper) === 'folder' ? wrapper : null;
    } },
    ClipProjectItem: { cast(raw) {
      const wrapper = fromBase(raw);
      return kinds.get(wrapper) === 'clip' ? wrapper : null;
    } },
    Constants: { TrackItemType: { CLIP: 1 } },
  };
  return { register, base, ppro };
}

module.exports = { createItemViews };
