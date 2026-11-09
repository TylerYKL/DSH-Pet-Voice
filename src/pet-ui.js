// Floating pet UI component
export class PetUI {
  constructor(container) {
    this.container = container;
    this.state = 'idle';
    this.onStyleChange = null;
    this.build();
    this.bindDrag();
  }

  build() {
    this.el = document.createElement('div');
    this.el.id = 'voice-pet';
    this.el.style.cssText = `
      position:fixed;right:24px;bottom:24px;width:80px;height:80px;
      cursor:grab;z-index:9999;user-select:none;
    `;
    this.el.innerHTML = `
      <div class="pet-body" style="
        width:80px;height:80px;border-radius:50%;
        background:radial-gradient(circle at 35% 30%,#fbbf24,#f59e0b 60%,#b45309);
        box-shadow:0 6px 20px rgba(0,0,0,.5);
        animation:breathe 3s ease-in-out infinite;
        position:relative;
      ">
        <div style="position:absolute;top:22px;left:14px;width:52px;height:32px;">
          <div class="eye" style="position:absolute;top:4px;left:6px;width:10px;height:12px;background:#1e293b;border-radius:50%;animation:blink 4s infinite;"></div>
          <div class="eye" style="position:absolute;top:4px;right:6px;width:10px;height:12px;background:#1e293b;border-radius:50%;animation:blink 4s infinite;"></div>
          <div class="mouth" style="position:absolute;bottom:4px;left:50%;transform:translateX(-50%);width:16px;height:5px;background:#1e293b;border-radius:0 0 8px 8px;transition:all .15s;"></div>
        </div>
      </div>
      <div class="bubble" style="
        position:absolute;bottom:90px;right:0;
        background:#fff;color:#0f172a;padding:6px 10px;
        border-radius:10px;font-size:12px;max-width:160px;
        box-shadow:0 4px 12px rgba(0,0,0,.3);
        opacity:0;transform:translateY(6px);transition:opacity .2s,transform .2s;
        pointer-events:none;
      "></div>
    `;
    this.container.appendChild(this.el);

    // inject keyframes
    if (!document.getElementById('voice-pet-kf')) {
      const style = document.createElement('style');
      style.id = 'voice-pet-kf';
      style.textContent = `
        @keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}
        @keyframes blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}
        @keyframes talk{from{height:5px;width:16px}to{height:12px;width:10px;border-radius:50%}}
        @keyframes shake{0%,100%{transform:rotate(-2deg)}50%{transform:rotate(2deg)}}
      `;
      document.head.appendChild(style);
    }
  }

  setState(s) {
    this.state = s;
    const body = this.el.querySelector('.pet-body');
    const mouth = this.el.querySelector('.mouth');
    if (s === 'speaking') {
      body.style.animation = 'shake .2s infinite';
      mouth.style.animation = 'talk .25s infinite alternate';
    } else {
      body.style.animation = 'breathe 3s ease-in-out infinite';
      mouth.style.animation = '';
    }
  }

  showBubble(text) {
    const b = this.el.querySelector('.bubble');
    b.textContent = text;
    b.style.opacity = '1';
    b.style.transform = 'translateY(0)';
    clearTimeout(this._bt);
    this._bt = setTimeout(() => {
      b.style.opacity = '0';
      b.style.transform = 'translateY(6px)';
    }, 3000);
  }

  bindDrag() {
    let dragging = false, ox = 0, oy = 0;
    this.el.addEventListener('mousedown', (e) => {
      dragging = true;
      const r = this.el.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      this.el.style.right = 'auto'; this.el.style.bottom = 'auto';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      this.el.style.left = (e.clientX - ox) + 'px';
      this.el.style.top = (e.clientY - oy) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }
}
