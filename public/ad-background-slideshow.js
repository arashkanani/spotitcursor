(function (global) {
  const FADE_MS = 900;
  const INTERVAL_MS = 5000;

  function clampPercent(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(150, Math.max(-50, Math.round(n)));
  }

  function clampScale(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(500, Math.max(25, Math.round(n)));
  }

  function normalizeSlide(slide) {
    if (!slide) return null;
    const url = typeof slide === "string" ? slide : slide.url;
    if (!url) return null;
    return {
      url,
      posX: clampPercent(slide.posX, 50),
      posY: clampPercent(slide.posY, 50),
      scale: clampScale(slide.scale, 100)
    };
  }

  class AdBackgroundSlideshow {
    constructor(root) {
      this.root = root;
      this.layers = Array.from(root.querySelectorAll(".ad-bg-layer"));
      this.timer = null;
      this.index = 0;
      this.slides = [];
      this.activeLayer = 0;
      this.running = false;
    }

    paintLayer(layer, slide) {
      const item = normalizeSlide(slide);
      if (!layer || !item) return;
      layer.style.backgroundColor = "#080c18";
      layer.style.backgroundImage = `url("${item.url}")`;
      layer.style.backgroundPosition = `${item.posX}% ${item.posY}%`;
      layer.style.backgroundSize = `${item.scale}% auto`;
      layer.style.backgroundRepeat = "no-repeat";
    }

    setVisibleLayer(layerIndex) {
      this.layers.forEach((layer, i) => {
        layer.classList.toggle("is-visible", i === layerIndex);
      });
      this.activeLayer = layerIndex;
    }

    advance() {
      if (this.slides.length < 2) return;
      const nextIndex = (this.index + 1) % this.slides.length;
      const inactiveLayer = 1 - this.activeLayer;
      this.paintLayer(this.layers[inactiveLayer], this.slides[nextIndex]);
      this.setVisibleLayer(inactiveLayer);
      this.index = nextIndex;
    }

    stop() {
      this.running = false;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.root.classList.add("hidden");
      this.root.setAttribute("aria-hidden", "true");
      this.layers.forEach((layer) => {
        layer.classList.remove("is-visible");
        layer.style.backgroundImage = "";
      });
      document.body.classList.remove("ad-bg-slideshow-active");
    }

    start() {
      if (this.slides.length < 2) {
        this.stop();
        return;
      }
      this.running = true;
      this.root.classList.remove("hidden");
      this.root.setAttribute("aria-hidden", "false");
      document.body.classList.add("ad-bg-slideshow-active");
      this.index = 0;
      this.paintLayer(this.layers[0], this.slides[0]);
      this.setVisibleLayer(0);
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => this.advance(), INTERVAL_MS);
    }

    slidesSignature(slides) {
      return slides.map((slide) => {
        const item = normalizeSlide(slide);
        return item
          ? `${item.url}|${item.posX}|${item.posY}|${item.scale}`
          : "";
      }).join(";;");
    }

    update(options = {}) {
      const rawSlides = Array.isArray(options.slides)
        ? options.slides
        : (Array.isArray(options.urls)
          ? options.urls.map((url) => ({
            url,
            posX: options.posX,
            posY: options.posY,
            scale: options.scale
          }))
          : []);
      const slides = rawSlides.map(normalizeSlide).filter(Boolean);
      const prevSignature = this.slidesSignature(this.slides);
      const nextSignature = this.slidesSignature(slides);

      if (!options.running || slides.length < 2) {
        this.slides = slides;
        this.stop();
        return;
      }

      const wasRunning = this.running;
      this.slides = slides;
      if (!wasRunning || prevSignature !== nextSignature) {
        this.start();
        return;
      }

      this.layers.forEach((layer) => {
        if (layer.classList.contains("is-visible")) {
          this.paintLayer(layer, slides[this.index]);
        }
      });
    }
  }

  function ensureRoot() {
    let root = document.getElementById("adBgSlideshow");
    if (root) return root;
    root = document.createElement("div");
    root.id = "adBgSlideshow";
    root.className = "ad-bg-slideshow hidden";
    root.setAttribute("aria-hidden", "true");
    root.innerHTML = `
      <div class="ad-bg-layer"></div>
      <div class="ad-bg-layer"></div>
    `;
    const mesh = document.querySelector("body > .bg-mesh");
    if (mesh && mesh.parentNode) {
      mesh.parentNode.insertBefore(root, mesh.nextSibling);
    } else {
      document.body.prepend(root);
    }
    return root;
  }

  let instance = null;

  global.AdBackgroundSlideshow = {
    FADE_MS,
    INTERVAL_MS,
    get() {
      if (!instance) {
        instance = new AdBackgroundSlideshow(ensureRoot());
      }
      return instance;
    },
    update(options) {
      global.AdBackgroundSlideshow.get().update(options);
    },
    stop() {
      if (instance) instance.stop();
    }
  };
})(window);
