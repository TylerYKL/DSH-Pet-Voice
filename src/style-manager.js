// Style registration and switching
export class StyleManager {
  constructor() {
    this.styles = {
      cute:  { name: '可爱', emoji: '🎀', color: '#f472b6' },
      mech:  { name: '机械', emoji: '🤖', color: '#94a3b8' },
      tech:  { name: '科技', emoji: '⚡', color: '#38bdf8' },
    };
    this.current = 'cute';
  }

  register(name, meta) {
    this.styles[name] = meta;
  }

  set(name) {
    if (this.styles[name]) this.current = name;
  }

  get(name) { return this.styles[name || this.current]; }
  list() { return Object.keys(this.styles); }
}
