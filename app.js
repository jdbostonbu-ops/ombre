/* ════════════════════════════════════════════════════════════════
   ÓMBRE · app.js
   Deep work environment — Pomodoro timer + procedural brown noise.
   Vanilla JS · no libraries · closure-based factory functions.
   textContent for any user-visible text (XSS-safe by construction).
   ════════════════════════════════════════════════════════════════ */

'use strict';

/* ─────────────────────────────────────────────────────────────
   TIMER FACTORY
   Encapsulates all timer state in a closure: time-remaining,
   the rAF handle, paused vs running, target end-time.

   Why requestAnimationFrame instead of setInterval?
   - rAF naturally pauses when the tab is backgrounded (saves battery)
   - When the tab returns, we recompute from a stored end-timestamp,
     so we don't drift across long sessions
   - Smoother UI: ticks aligned to display refresh rate

   Why store an end-timestamp instead of decrementing?
   - JS timers drift. setInterval(fn, 1000) over 25 min loses seconds.
   - If we record "session ends at Date.now() + duration_ms" and recompute
     on every frame, we stay accurate to the millisecond.
   ──────────────────────────────────────────────────────────── */

function createTimer({ onTick, onComplete }) {
    // Private state — held in the closure
    let _durationMs = 25 * 60 * 1000;
    let _endTime    = 0;        // wall-clock time when timer expires
    let _pausedAt   = 0;        // remaining ms when paused
    let _state      = 'idle';   // 'idle' | 'running' | 'paused' | 'done'
    let _rafId      = null;

    /* The tick loop — recomputes remaining time from the end timestamp,
       calls onTick, schedules the next frame. */
    function _loop() {
        if (_state !== 'running') return;
        const remaining = _endTime - Date.now();
        if (remaining <= 0) {
            _state = 'done';
            _rafId = null;
            onTick(0);
            onComplete();
            return;
        }
        onTick(remaining);
        _rafId = requestAnimationFrame(_loop);
    }

    return {
        /* Set the duration in minutes — only valid when idle. */
        setDuration(minutes) {
            if (_state !== 'idle' && _state !== 'done') return;
            _durationMs = Math.max(1, Number(minutes) || 25) * 60 * 1000;
            // Reset to idle with the new duration showing
            _state = 'idle';
            onTick(_durationMs);
        },

        /* Start a fresh session. */
        start() {
            if (_state === 'running') return;
            _endTime = Date.now() + _durationMs;
            _state = 'running';
            _loop();
        },

        /* Pause an active session — store remaining time. */
        pause() {
            if (_state !== 'running') return;
            _pausedAt = _endTime - Date.now();
            _state = 'paused';
            if (_rafId) cancelAnimationFrame(_rafId);
            _rafId = null;
        },

        /* Resume a paused session — re-anchor end-time to now + remaining. */
        resume() {
            if (_state !== 'paused') return;
            _endTime = Date.now() + _pausedAt;
            _state = 'running';
            _loop();
        },

        /* Reset to idle with the original duration. */
        reset() {
            if (_rafId) cancelAnimationFrame(_rafId);
            _rafId = null;
            _state = 'idle';
            onTick(_durationMs);
        },

        /* Public read-only state accessor */
        getState: () => _state,
        getDurationMs: () => _durationMs
    };
}


/* ─────────────────────────────────────────────────────────────
   NOISE GENERATOR FACTORY
   Generates BROWN, PINK, or WHITE noise procedurally via the
   Web Audio API. No audio files. The three algorithms:

   WHITE — pure random samples. Each sample independent of the last.
     data[i] = (Math.random() * 2 - 1) * 0.4
     Flat power spectrum, sharp/hissy character.

   PINK — Paul Kellet's classic filter cascade.
     Power decreases by 3 dB/octave. Sounds like steady rain.
     Uses 7 IIR filter stages summed.

   BROWN — Brownian random walk (integral of white noise).
     last = last * 0.97 + (Math.random() - 0.5) * 0.05
     Power decreases by 6 dB/octave. Smooth, deep, distant.

   Each color also runs through a low-pass filter at a different
   cutoff to keep all three feeling balanced. Brown stays heavily
   filtered (600 Hz), pink medium (4000 Hz), white lightly (8000 Hz).

   Mobile autoplay policy: AudioContext is created on first user
   gesture. We .resume() defensively on every play() in case the OS
   suspended the context (tab backgrounded, etc).
   ──────────────────────────────────────────────────────────── */

function createNoiseGenerator() {
    let _ctx       = null;        // AudioContext (lazy)
    let _gainNode  = null;
    let _filterNode= null;
    let _source    = null;
    let _isPlaying = false;
    let _volume    = 0.6;
    let _type      = 'brown';     // 'brown' | 'pink' | 'white'

    /* Filter cutoff per noise type. Brown is heavily filtered to keep
       only the deep rumble; pink and white get progressively more
       high-frequency content through. */
    const FILTER_CUTOFFS = {
        brown: 600,
        pink:  4000,
        white: 8000
    };

    /* Generate a 4-second AudioBuffer for the chosen noise type. */
    function _generateBuffer(ctx, type) {
        const sampleRate = ctx.sampleRate;
        const length     = sampleRate * 4;
        const buffer     = ctx.createBuffer(2, length, sampleRate);

        for (let channel = 0; channel < 2; channel++) {
            const data = buffer.getChannelData(channel);

            if (type === 'white') {
                // Pure random samples — no memory between samples
                for (let i = 0; i < length; i++) {
                    data[i] = (Math.random() * 2 - 1) * 0.4;
                }

            } else if (type === 'pink') {
                // Paul Kellet's pink-noise filter cascade
                // (https://www.firstpr.com.au/dsp/pink-noise/)
                // Seven IIR stages summed produce -3 dB/octave roll-off
                let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
                for (let i = 0; i < length; i++) {
                    const white = Math.random() * 2 - 1;
                    b0 = 0.99886 * b0 + white * 0.0555179;
                    b1 = 0.99332 * b1 + white * 0.0750759;
                    b2 = 0.96900 * b2 + white * 0.1538520;
                    b3 = 0.86650 * b3 + white * 0.3104856;
                    b4 = 0.55000 * b4 + white * 0.5329522;
                    b5 = -0.7616 * b5 - white * 0.0168980;
                    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
                    b6 = white * 0.115926;
                    data[i] = pink * 0.11; // amplitude scaling so it matches brown/white loudness
                }

            } else {
                // Default: brown noise — random walk with leak
                let last = 0;
                for (let i = 0; i < length; i++) {
                    last = last * 0.97 + (Math.random() - 0.5) * 0.05;
                    data[i] = last * 3.5;
                }
            }
        }
        return buffer;
    }

    /* Build the audio graph the first time noise is requested.
       Graph: source -> low-pass filter -> gain -> destination */
    function _ensureContext() {
        if (_ctx) return _ctx;

        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) throw new Error('Web Audio API not supported');

        _ctx = new Ctx();

        _filterNode = _ctx.createBiquadFilter();
        _filterNode.type = 'lowpass';
        _filterNode.frequency.value = FILTER_CUTOFFS[_type];
        _filterNode.Q.value = 0.5;

        _gainNode = _ctx.createGain();
        _gainNode.gain.value = 0;

        _filterNode.connect(_gainNode);
        _gainNode.connect(_ctx.destination);

        return _ctx;
    }

    /* Build a fresh source from the current noise type's buffer. */
    function _buildSource(ctx) {
        const buffer = _generateBuffer(ctx, _type);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(_filterNode);
        return source;
    }

    /* Start playback with a gentle exponential fade-in. */
    async function play(fadeMs = 800) {
        if (_isPlaying) return;
        const ctx = _ensureContext();

        if (ctx.state === 'suspended') {
            try { await ctx.resume(); } catch (e) { /* fall through */ }
        }

        _source = _buildSource(ctx);
        _source.start(0);

        const now = ctx.currentTime;
        _gainNode.gain.cancelScheduledValues(now);
        _gainNode.gain.setValueAtTime(0.0001, now);
        _gainNode.gain.exponentialRampToValueAtTime(
            Math.max(0.0001, _volume),
            now + fadeMs / 1000
        );

        _isPlaying = true;
    }

    /* Stop with a fade-out. */
    function stop(fadeMs = 600) {
        if (!_isPlaying || !_ctx || !_gainNode || !_source) return;

        const ctx = _ctx;
        const now = ctx.currentTime;
        const endTime = now + fadeMs / 1000;

        _gainNode.gain.cancelScheduledValues(now);
        _gainNode.gain.setValueAtTime(_gainNode.gain.value, now);
        _gainNode.gain.exponentialRampToValueAtTime(0.0001, endTime);

        const sourceToStop = _source;
        sourceToStop.stop(endTime + 0.05);

        _isPlaying = false;
        _source = null;
    }

    /* Long fade-out — used when the timer reaches zero. */
    function fadeOut(fadeMs = 2000) {
        stop(fadeMs);
    }

    /* Switch noise type. If currently playing, smoothly fades old type
       out while starting the new type — no audible gap. */
    async function setType(newType) {
        if (!['brown', 'pink', 'white'].includes(newType)) return;
        if (newType === _type) return;
        _type = newType;

        // Update filter cutoff immediately if context exists
        if (_filterNode && _ctx) {
            const now = _ctx.currentTime;
            _filterNode.frequency.cancelScheduledValues(now);
            _filterNode.frequency.setValueAtTime(_filterNode.frequency.value, now);
            _filterNode.frequency.linearRampToValueAtTime(FILTER_CUTOFFS[newType], now + 0.3);
        }

        // If currently playing, crossfade from old source to new source
        if (_isPlaying && _ctx && _gainNode) {
            const ctx = _ctx;
            const now = ctx.currentTime;

            // Fade old source out fast
            _gainNode.gain.cancelScheduledValues(now);
            _gainNode.gain.setValueAtTime(_gainNode.gain.value, now);
            _gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);

            const oldSource = _source;
            oldSource.stop(now + 0.3);

            // Build new source on the new type and fade it in
            // (small delay so old source has time to finish its fade)
            setTimeout(() => {
                if (!_ctx) return; // context may have been destroyed
                _source = _buildSource(_ctx);
                _source.start(0);
                const t = _ctx.currentTime;
                _gainNode.gain.cancelScheduledValues(t);
                _gainNode.gain.setValueAtTime(0.0001, t);
                _gainNode.gain.exponentialRampToValueAtTime(
                    Math.max(0.0001, _volume),
                    t + 0.4
                );
            }, 250);
        }
    }

    /* Volume setter, 0..1. Smooth-ramps if currently playing. */
    function setVolume(v) {
        _volume = Math.max(0, Math.min(1, Number(v) || 0));
        if (_isPlaying && _ctx && _gainNode) {
            const now = _ctx.currentTime;
            _gainNode.gain.cancelScheduledValues(now);
            _gainNode.gain.setValueAtTime(_gainNode.gain.value, now);
            _gainNode.gain.linearRampToValueAtTime(_volume, now + 0.15);
        }
    }

    return {
        play,
        stop,
        fadeOut,
        setVolume,
        setType,
        getType: () => _type,
        isPlaying: () => _isPlaying
    };
}


/* ─────────────────────────────────────────────────────────────
   FORMAT — pure helper, no state.
   Convert milliseconds to "M:SS" (or "MM:SS" for >= 10 min).
   ──────────────────────────────────────────────────────────── */

function formatTime(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}


/* ─────────────────────────────────────────────────────────────
   STATUS PHRASES
   Italic-serif lines for each session state. Quiet, never urgent.
   The same phrase isn't repeated within a state to keep things
   from feeling robotic.
   ──────────────────────────────────────────────────────────── */

const STATUS_PHRASES = {
    idle:    ['Settle in.', 'Ready when you are.', 'Begin in your own time.'],
    running: ['Stay in the shadow.', 'Quiet hands.', 'Keep going.'],
    paused:  ['Holding your place.', 'Take a breath.'],
    done:    ['A session well kept.', 'Time honored.', 'Quiet again.']
};

/* Pick a random phrase for a state. */
function pickStatus(state) {
    const phrases = STATUS_PHRASES[state] || [''];
    return phrases[Math.floor(Math.random() * phrases.length)];
}


/* ─────────────────────────────────────────────────────────────
   WAVEFORM ANIMATOR
   When brown noise is active, the small SVG path under the toggle
   gently breathes (subtle sine wave). Pure cosmetic — does not
   affect audio. Driven by rAF for smoothness.
   ──────────────────────────────────────────────────────────── */

function createWaveAnimator(pathEl) {
    let _rafId = null;
    let _phase = 0;

    function _tick() {
        _phase += 0.015;
        // Build a smooth sine path across the 120-unit viewport
        const points = [];
        for (let x = 0; x <= 120; x += 4) {
            const y = 7 + Math.sin((x / 120) * Math.PI * 4 + _phase) * 2.5;
            points.push(`${x === 0 ? 'M' : 'L'}${x} ${y.toFixed(2)}`);
        }
        pathEl.setAttribute('d', points.join(' '));
        _rafId = requestAnimationFrame(_tick);
    }

    return {
        start() {
            if (_rafId) return;
            _tick();
        },
        stop() {
            if (_rafId) cancelAnimationFrame(_rafId);
            _rafId = null;
            // Reset to flat line
            pathEl.setAttribute('d', 'M0 7 L120 7');
        }
    };
}


/* ─────────────────────────────────────────────────────────────
   TOAST — small italic-serif transient feedback
   ──────────────────────────────────────────────────────────── */

function showToast(message, ms = 2200) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    void toast.offsetWidth; // force reflow so transition fires
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => { toast.hidden = true; }, 350);
    }, ms);
}


/* ─────────────────────────────────────────────────────────────
   INIT — wire it all together
   ──────────────────────────────────────────────────────────── */

function init() {

    /* Refs — collected once at startup */
    const $ = (id) => document.getElementById(id);
    const timeEl       = $('time');
    const statusEl     = $('status');
    const presetsEl    = $('presets');
    const presetBtns   = Array.from(presetsEl.querySelectorAll('.preset'));
    const primaryBtn   = $('primaryBtn');
    const secondaryBtn = $('secondaryBtn');
    const noiseToggle  = $('noiseToggle');
    const noiseHelp    = $('noiseHelp');
    const helpModal    = $('helpModal');
    const helpCloseBtn = $('helpCloseBtn');
    const helpDoneBtn  = $('helpDoneBtn');
    const volumeWrap   = $('volume');
    const volSlider    = $('volSlider');
    const wavePath     = $('wavePath1');

    /* Build the wave animator (cosmetic) */
    const wave = createWaveAnimator(wavePath);

    /* Build the noise generator (lazy AudioContext, no init cost). Brown by default. */
    const noise = createNoiseGenerator();

    /* Build the timer with callbacks for tick + complete */
    const timer = createTimer({
        onTick: (remainingMs) => {
            timeEl.textContent = formatTime(remainingMs);
            // Update document title so it remains visible across tabs
            const state = timer.getState();
            if (state === 'running') {
                document.title = `${formatTime(remainingMs)} · Ómbre`;
            }
        },
        onComplete: () => {
            // Timer reached zero — the soft moment of completion
            document.body.classList.remove('is-live');
            document.body.classList.add('is-done');
            statusEl.textContent = pickStatus('done');
            primaryBtn.textContent = 'Again';
            secondaryBtn.textContent = 'Done';
            secondaryBtn.hidden = false;
            // Show presets again so the user can pick a new length
            presetsEl.hidden = false;

            // Brown noise gently fades over 2 seconds, per spec
            if (noise.isPlaying()) {
                noise.fadeOut(2000);
                wave.stop();
                // Update toggle pressed state — noise is no longer on
                noiseToggle.setAttribute('aria-pressed', 'false');
                volumeWrap.hidden = true;
            }

            // Restore document title
            document.title = 'Ómbre · Stay in the shadow.';

            // Soft notification — also vibrates on supported phones
            if ('vibrate' in navigator) {
                try { navigator.vibrate([60, 40, 60]); } catch {}
            }
            showToast('Session complete.');
        }
    });

    /* ── Preset button clicks ── */
    presetBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Only allowed in idle state
            if (timer.getState() !== 'idle' && timer.getState() !== 'done') return;
            const minutes = parseInt(btn.dataset.minutes, 10);
            timer.setDuration(minutes);
            // Update active class
            presetBtns.forEach(b => {
                b.classList.toggle('is-active', b === btn);
                b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
            });
            // After picking a new duration, we're effectively idle again
            document.body.classList.remove('is-done');
            statusEl.textContent = pickStatus('idle');
            primaryBtn.textContent = 'Begin';
            secondaryBtn.hidden = true;
        });
    });

    /* ── Primary action button — Begin / Pause / Resume / Again ── */
    primaryBtn.addEventListener('click', () => {
        const state = timer.getState();
        if (state === 'idle') {
            // Begin a fresh session
            timer.start();
            document.body.classList.add('is-live');
            document.body.classList.remove('is-done');
            statusEl.textContent = pickStatus('running');
            primaryBtn.textContent = 'Pause';
            secondaryBtn.textContent = 'Reset';
            secondaryBtn.hidden = false;
            // Hide presets so the screen quiets down
            presetsEl.hidden = true;
        } else if (state === 'running') {
            timer.pause();
            primaryBtn.textContent = 'Resume';
            statusEl.textContent = pickStatus('paused');
            document.body.classList.remove('is-live');
        } else if (state === 'paused') {
            timer.resume();
            primaryBtn.textContent = 'Pause';
            statusEl.textContent = pickStatus('running');
            document.body.classList.add('is-live');
        } else if (state === 'done') {
            // "Again" — restart with the same duration
            timer.reset();
            timer.start();
            document.body.classList.add('is-live');
            document.body.classList.remove('is-done');
            statusEl.textContent = pickStatus('running');
            primaryBtn.textContent = 'Pause';
            secondaryBtn.textContent = 'Reset';
            secondaryBtn.hidden = false;
            presetsEl.hidden = true;
        }
    });

    /* ── Secondary button — Reset (during) or Done (after) ── */
    secondaryBtn.addEventListener('click', () => {
        const state = timer.getState();
        if (state === 'done') {
            // "Done" — return to idle screen with current duration
            timer.reset();
            document.body.classList.remove('is-done');
            statusEl.textContent = pickStatus('idle');
            primaryBtn.textContent = 'Begin';
            secondaryBtn.hidden = true;
            presetsEl.hidden = false;
        } else {
            // Reset — abandon current session
            timer.reset();
            document.body.classList.remove('is-live', 'is-done');
            statusEl.textContent = pickStatus('idle');
            primaryBtn.textContent = 'Begin';
            secondaryBtn.hidden = true;
            presetsEl.hidden = false;
            document.title = 'Ómbre · Stay in the shadow.';
        }
    });

    /* ── Brown noise toggle ──
       MUST be triggered by a user gesture to satisfy mobile autoplay
       policies. The click handler IS that gesture. */
    noiseToggle.addEventListener('click', async (e) => {
        // Don't toggle if the click was on the help (?) button inside
        if (e.target.closest('#noiseHelp')) return;

        const isOn = noiseToggle.getAttribute('aria-pressed') === 'true';
        if (isOn) {
            noise.stop(600);
            noiseToggle.setAttribute('aria-pressed', 'false');
            wave.stop();
            volumeWrap.hidden = true;
        } else {
            try {
                await noise.play(800);
                noiseToggle.setAttribute('aria-pressed', 'true');
                wave.start();
                volumeWrap.hidden = false;
            } catch (err) {
                console.error('Noise generator failed:', err);
                showToast('Audio not available in this browser.');
            }
        }
    });

    /* ── Noise color picker (brown / pink / white) ── */
    const noiseColorBtns = Array.from(window.document.querySelectorAll('.ncolor'));
    const noiseLabel = $('noiseLabel');
    noiseColorBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            const newType = btn.dataset.noise;
            if (!newType || newType === noise.getType()) return;

            // Update active state on the buttons
            noiseColorBtns.forEach(b => {
                b.classList.toggle('is-active', b === btn);
                b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
            });

            // Update the label text + help button aria-label
            const labelText = newType.charAt(0).toUpperCase() + newType.slice(1) + ' noise';
            noiseLabel.textContent = labelText;
            noiseHelp.setAttribute('aria-label', `What is ${newType} noise?`);

            // Switch the noise type — crossfades smoothly if currently playing
            try {
                await noise.setType(newType);
            } catch (err) {
                console.error('Noise type switch failed:', err);
            }
        });
    });

    /* ── Volume slider ── */
    volSlider.addEventListener('input', (e) => {
        const v = parseInt(e.target.value, 10) / 100;
        noise.setVolume(v);
    });

    /* ── Help modal (the "?" next to "Brown noise") ── */
    noiseHelp.addEventListener('click', (e) => {
        e.stopPropagation(); // don't trigger the toggle parent
        helpModal.hidden = false;
    });
    function closeHelp() { helpModal.hidden = true; }
    helpCloseBtn.addEventListener('click', closeHelp);
    helpDoneBtn.addEventListener('click', closeHelp);
    helpModal.addEventListener('click', (e) => {
        if (e.target === helpModal) closeHelp();
    });

    /* ── Keyboard shortcuts — power user touches ──
       Space: start/pause/resume
       R: reset
       N: toggle brown noise
       Escape: close any open modal */
    document.addEventListener('keydown', (e) => {
        // Don't intercept while user is typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        if (e.key === 'Escape') {
            if (!helpModal.hidden) closeHelp();
            return;
        }
        if (e.code === 'Space') {
            e.preventDefault();
            primaryBtn.click();
        } else if (e.key === 'r' || e.key === 'R') {
            if (!secondaryBtn.hidden) secondaryBtn.click();
        } else if (e.key === 'n' || e.key === 'N') {
            noiseToggle.click();
        }
    });

    /* ── Service worker (PWA install + offline) ── */
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(err => {
            console.warn('Ómbre: service worker registration failed.', err);
        });
    }

    /* Initial render */
    timer.setDuration(25);
    statusEl.textContent = pickStatus('idle');
}

/* Boot */
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
