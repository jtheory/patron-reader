// Listen mode: reads a list of text blocks (paragraphs) aloud, one at a time.
//
// The speech engine is a small interface so a native app can swap in Android's
// TextToSpeech later without touching the reader:
//   engine.speak(text, { rate, voice, lang }) -> Promise (resolves when finished)
//   engine.cancel()
//   engine.voices() -> [{ id, name, lang, isDefault }]
//   engine.speaking() -> boolean

export function webSpeechEngine() {
  const synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") return null;
  let current = null;
  let epoch = 0; // bumped by cancel(), so a sentence still waiting for voices is dropped
  // Chrome loads its voice list in the background: right after launch it's
  // often empty, and an utterance without a voice gets the device default
  // (e.g. American English for the first sentence, then the chosen voice).
  // So wait for the list before the first sentence, but not forever.
  // The list can also arrive in parts, so wait for the chosen voice itself.
  // Give up after 2s (the voice may have been uninstalled) and don't wait for
  // that voice again; the utterance's language still steers the engine.
  const find = (id) => synth.getVoices().find((x) => x.voiceURI === id);
  const missing = new Set();
  const voiceReady = (id) => {
    if (find(id) || missing.has(id)) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => find(id) && finish();
      const finish = () => {
        synth.removeEventListener?.("voiceschanged", check);
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      };
      synth.addEventListener?.("voiceschanged", check);
      const poll = setInterval(check, 100); // not every build fires voiceschanged
      const timer = setTimeout(() => {
        missing.add(id);
        finish();
      }, 2000);
    });
  };
  return {
    async speak(text, { rate = 1, voice = "", lang = "" } = {}) {
      const mine = epoch;
      if (voice) await voiceReady(voice);
      if (mine !== epoch) return;
      return new Promise((resolve, reject) => {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = rate;
        const v = voice && find(voice);
        if (v) {
          u.voice = v;
          u.lang = v.lang;
        } else if (lang) u.lang = lang;
        u.onend = () => resolve();
        u.onerror = (e) => (e.error === "interrupted" || e.error === "canceled" ? resolve() : reject(e.error));
        current = u; // keep a reference: Chrome can garbage-collect live utterances
        synth.speak(u);
      });
    },
    cancel() {
      epoch++;
      current = null;
      synth.cancel();
    },
    speaking: () => synth.speaking,
    voices: () =>
      synth.getVoices().map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang, isDefault: v.default })),
    onVoicesChanged(fn) {
      synth.addEventListener?.("voiceschanged", fn);
    },
  };
}

// Split a paragraph into sentence-sized chunks. Short utterances are more
// reliable (some engines stop long ones early) and make pause/resume cheap.
export function chunk(text, max = 220) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g) || [clean];
  const out = [];
  let buf = "";
  for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
    if (s.length > max) {
      if (buf) out.push(buf), (buf = "");
      // Very long sentence: break at commas or spaces.
      let rest = s;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(", ", max);
        if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
        if (cut < 1) cut = max;
        out.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1);
      }
      buf = rest.trim();
    } else if ((buf + " " + s).trim().length > max) {
      out.push(buf);
      buf = s;
    } else buf = (buf + " " + s).trim();
  }
  if (buf) out.push(buf);
  return out;
}

export class Listener {
  constructor(engine, { onIndex = () => {}, onState = () => {}, onFinish = () => {} } = {}) {
    this.engine = engine;
    this.onIndex = onIndex;
    this.onState = onState;
    this.onFinish = onFinish;
    this.blocks = [];
    this.index = 0;
    this.part = 0;
    this.state = "stopped"; // stopped | playing | paused
    this.rate = 1;
    this.voice = "";
    this.lang = ""; // the voice's language, used if the voice itself isn't available
    this.gen = 0; // bumped on every interruption so stale callbacks are ignored
  }

  // blocks: array of strings, one per paragraph (empty strings are skipped).
  start(blocks, index = 0) {
    this.blocks = blocks;
    this.index = Math.max(0, Math.min(index, blocks.length - 1));
    this.part = 0;
    this.skipEmpty(1);
    this.play();
  }

  play() {
    if (!this.blocks.length) return;
    this.suspended = false;
    this.engine.cancel();
    const gen = ++this.gen;
    this.setState("playing");
    this.onIndex(this.index);
    this.loop(gen);
  }

  async loop(gen) {
    while (gen === this.gen && this.index < this.blocks.length) {
      const parts = chunk(this.blocks[this.index]);
      while (gen === this.gen && this.part < parts.length) {
        // Remember where each sentence started, to resume accurately after interruptions.
        this.at = { index: this.index, part: this.part, t: Date.now(), prev: this.at && { ...this.at, prev: null } };
        try {
          await this.engine.speak(parts[this.part], { rate: this.rate, voice: this.voice, lang: this.lang });
        } catch {
          // Engine error: stop rather than race through the text silently.
          if (gen === this.gen) this.pause();
          return;
        }
        if (gen !== this.gen) return;
        this.part++;
      }
      if (gen !== this.gen) return;
      this.index++;
      this.part = 0;
      this.skipEmpty(1);
      if (this.index < this.blocks.length) this.onIndex(this.index);
    }
    if (gen === this.gen) {
      this.setState("stopped");
      this.onFinish();
    }
  }

  skipEmpty(dir) {
    while (this.index >= 0 && this.index < this.blocks.length && !this.blocks[this.index].trim()) this.index += dir;
    if (this.index < 0) this.index = 0;
  }

  pause() {
    if (this.state !== "playing") return;
    this.suspended = false;
    this.gen++;
    this.engine.cancel();
    this.setState("paused");
  }

  toggle() {
    if (this.state === "playing") this.pause();
    else this.play();
  }

  // The app went to the background: the sentence being spoken gets cut off.
  // Engines often report it as *finished*, which would skip ahead, so stop
  // listening to the engine now and rewind to the start of that sentence.
  // If the "next" sentence began only moments ago, that was the engine racing
  // ahead after the cut: go back one more.
  suspend() {
    if (this.state !== "playing") return;
    this.gen++;
    let at = this.at;
    if (at && at.prev && Date.now() - at.t < 400) at = at.prev;
    if (at) {
      this.index = at.index;
      this.part = at.part;
    }
    this.suspended = true;
    this.engine.cancel();
  }

  resume() {
    if (this.suspended && this.state === "playing") {
      this.suspended = false;
      this.play();
    }
  }

  // Resume the current sentence if the engine went quiet unexpectedly.
  nudge() {
    if (this.suspended) return this.resume();
    if (this.state === "playing" && !this.engine.speaking()) this.play();
  }

  jump(dir) {
    if (!this.blocks.length) return;
    this.index = Math.max(0, Math.min(this.blocks.length - 1, this.index + dir));
    this.part = 0;
    this.skipEmpty(dir || 1);
    if (this.state === "playing") this.play();
    else this.onIndex(this.index);
  }

  // Move to the start of a paragraph without playing (e.g. where the reader scrolled to).
  seek(index) {
    this.index = Math.max(0, Math.min(this.blocks.length - 1, index));
    this.part = 0;
    this.skipEmpty(1);
  }

  setRate(rate) {
    this.rate = rate;
    if (this.state === "playing") this.play(); // restart the sentence at the new speed
  }

  stop() {
    this.gen++;
    this.engine.cancel();
    this.setState("stopped");
  }

  setState(s) {
    this.state = s;
    this.onState(s);
  }
}
