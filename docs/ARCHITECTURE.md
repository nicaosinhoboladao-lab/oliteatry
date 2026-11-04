# OLiteatry — Engineering Architecture & Roadmap

**Status:** Draft v0.1 · **Audience:** core contributors, technical reviewers, GSoC/mentor-level collaborators
**Scope:** desktop content-creation suite for virtual theater, machinima, avatar-driven performance, and recording. Not a game, not a runtime for players — a *production tool*.

---

## 0. Decision summary

| # | Decision | Choice | Rationale (short) |
|---|----------|--------|-------------------|
| D1 | Engine host | **Unity 6 LTS + URP** | Only ecosystem with mature, cheap VRM + webcam-tracking pipeline; best custom-shader control for the paper/PS2 identity; ~C# iteration speed for a small OSS team |
| D2 | "Open-source" meaning | **Our code is open; the engine is not** | Neither Unity nor Unreal is OSI-open. We open 100 % of OLiteatry's source, keep the license story honest, and hedge with an engine-agnostic core (D3) |
| D3 | Engine boundary | **`OLiteatry.Core` = engine-agnostic .NET library** | Timeline, project format, i18n, viseme mapping, procedural motion math live outside Unity → portability + unit-testability + no lock-in in the file format |
| D4 | Project format | **Engine-neutral JSON + content-addressed asset store** (`.oliteproj` = directory, zipped on export) | Never serialize `UnityEngine` types. This is the single most important anti-lock-in rule |
| D5 | Process model | **Shell/UI process + Renderer process + CLI renderer** | A crash in the recorder must not destroy an unsaved performance; headless CLI is required for CI and farm rendering |
| D6 | Performance clock | **Audio DSP clock is master**, video frames are quantized observers | Lip-sync drift is the #1 failure mode in avatar tools. One clock, one truth |
| D7 | Procedural motion | **Layered additive stack** (base idle → micro → emphasis → look-at) with **seeded** PRNG | Deterministic re-renders, no animation-authoring burden, no uncanny "metronome" motion |
| D8 | i18n | **Fluent (`.ftl`)** for strings, ICU for numbers/dates, **MSDF font fallback chains**, per-locale voice registry | Handles plurals/gender correctly in pt-BR and Slavic/Asian locales without string-concat hacks |
| D9 | License | **Apache-2.0** (code) · **CC0** (bundled assets) · **OFL** (fonts) | Patent grant + corporate-friendly; assets must be redistributable or the repo is legally poisoned |
| D10 | Recorder | **Offline frame-accurate (PNG/ProRes master)** + **real-time (AMF/NVENC)** | Never let OBS-style realtime be the master; quality tier matters for a production tool |

Weighted engine scoring (see §1.2): **Unity 82.0 / Godot 73.2 / Unreal 61.6** out of 100.

---

## 1. Engine / framework selection

### 1.1 The licensing reality (state it plainly, up front)

This is the part most "open-source game tool" specs get wrong, so it goes first.

| Engine | Source availability | OSI open source? | Cost model | Practical consequence for OLiteatry |
|---|---|---|---|---|
| **Unity 6** | C# reference source + packages only; engine core closed | **No** | Personal free under a revenue/funding threshold; Pro above it; the 2024 Runtime Fee was cancelled — *but the precedent is the risk* | We can open 100 % of *our* code; we cannot open the engine. Distributing an "open-source" binary still bundles a proprietary runtime |
| **Unreal Engine 5** | Full C++ source on GitHub under Epic's EULA | **No** (source-available, not OSI) | Free under a lifetime gross-revenue threshold, then a royalty on gross revenue | Contributors need Epic org access to even compile; royalties + EULA clause conflicts with some redistribution models |
| **Godot 4.x** | Full source, MIT | **Yes** | Free | Genuinely open. Weaker VRM production pipeline, no first-party FBX, no Unity-Recorder-class export |
| **O3DE** | Full source, Apache-2.0 | **Yes** | Free | Excellent license, thin avatar/VRM ecosystem — wrong tool for this brief |
| **Bevy / custom** | MIT/Apache | **Yes** | Free | Would consume 18+ months of engine work before feature #1. Rejected |

**Honest framing for the README:** *"OLiteatry is free and open-source software. Its source code is licensed Apache-2.0. It currently runs on Unity 6, a proprietary engine we do not control; see `docs/adr/0001` for the portability strategy and `docs/LICENSING.md` for what that means for you."* Anything vaguer gets you a Hacker News thread and a locked issue tracker.

### 1.2 Weighted comparison

Scores 1–5 per criterion, weights sum to 100. Scores reflect *this project's* needs, not general engine quality.

| Criterion | Weight | Unity 6 + URP | Unreal 5 | Godot 4 |
|---|---|---|---|---|
| VRM / avatar + face-tracking ecosystem | 18 | 5 | 2 | 4 |
| License fit for an OSS project | 15 | 3 | 2 | 5 |
| Stylized rendering + custom UI shaders | 14 | 5 | 4 | 3 |
| Desktop iteration velocity | 12 | 4 | 2 | 4 |
| Recording / video export pipeline | 10 | 4 | 5 | 2 |
| Animation & timeline tooling | 9 | 3 | 5 | 3 |
| Asset import (VRM/FBX/OBJ/audio) | 8 | 5 | 3 | 3 |
| Localization & text rendering | 6 | 4 | 4 | 3 |
| Contributor accessibility | 5 | 4 | 2 | 5 |
| Long-term license / legal risk | 3 | 2 | 3 | 5 |
| **Weighted total** | **100** | **82.0** | **61.6** | **73.2** |

Per-criterion weighted contributions (Unity / Unreal / Godot): avatar 18.0/7.2/14.4 · license 9.0/6.0/15.0 · stylized rendering 14.0/11.2/8.4 · velocity 9.6/4.8/9.6 · recording 8.0/10.0/4.0 · animation 5.4/9.0/5.4 · import 8.0/4.8/4.8 · text 4.8/4.8/3.6 · contributors 4.0/2.0/5.0 · legal risk 1.2/1.8/3.0.

### 1.3 Why Unity wins *for this feature set*

1. **VRM is the avatar lingua franca, and UniVRM is Unity-native.** Official MIT runtime, VRM 0.x + 1.0, spring bones, expression presets, first-person settings, meta/license flags — all of which we must *display to the user* (see §5.3). In Unreal this is a community plugin with partial coverage; in Godot it is a strong but thinner addon.
2. **Webcam tracking is a solved, cheap problem in C#.** OpenSeeFace-class models via ONNX Runtime / Barracuda, MediaPipe-class pose+hands, Kalidokit-style retargeting. This is the VSeeFace lineage; fighting it in C++ costs months.
3. **The UI identity needs custom shaders per element.** uGUI + TextMeshPro exposes materials per graphic; UI Toolkit does not give you arbitrary shaders on elements. Paper grain, ink bleed, wax-seal 9-slices, dither overlays: uGUI wins outright.
4. **Iteration velocity.** Domain reload + assembly definitions gives ~1–3 s edit-compile-play loops on a 8-core Ryzen. Unreal C++ hot-reload/Live Coding is workable but slower, and engine source builds are 100 GB+ — a hostile onboarding cost for contributors.
5. **Recorder exists.** Unity Recorder (UPM) gives frame-accurate PNG/ProRes/WebM sequences out of the box; we wrap it and add our own deterministic frame clock.

### 1.4 Why not Unreal (and what we give up)

Unreal would win on Sequencer (multi-cam, takes, sub-sequences), virtual-production lighting, and final pixel quality — i.e. exactly the "cinematic" bullet. We accept a weaker built-in sequencer and **build our own timeline** (which we need anyway, because our timeline is audio-first and avatar-first, not level-first). We do *not* accept Unreal's contributor friction: requiring an Epic account + EULA acceptance to compile the editor is a hard blocker for a GitHub-native project.

### 1.5 Why not Godot (yet)

Godot is the correct answer to "open source" and the wrong answer to "ship VRM + lipsync + recorder in 12 months." It is our **Track B**: because of D3/D4, a Godot host is a port, not a rewrite. Re-evaluate if (a) Godot's VRM/retarget tooling matures, or (b) Unity's licensing changes again.

### 1.6 Rendering the "Medieval Paper + PS2 Purple" identity

Three independent stacks — keep them decoupled so the *world* can be photoreal while the *chrome* is parchment.

**A. UI material stack (engine-agnostic theme tokens → shaders)**
- Theme tokens in `themes/grimoire.theme.json`: palette (parchment `#E8DCC0`-family, ink `#2B1B3D`, violet accents), grain intensity, edge wear, dither on/off, corner radius per component class.
- `Parchment.shader`: 3-octave value noise + fibrous streak mask + edge darkening + subtle paper-curl normal; multiplied, never replacing base tint (so themes can be swapped).
- `Ink.shader` for TMP: SDF outline with slight erosion noise on the edge → "bleeding ink", plus optional hatched shadow via a screen-space pattern.
- 9-slice frames as *hand-drawn* atlases (illustrator/Blender-authored, CC0) — not procedural, because hand-drawn corners are what sells the look.
- Accessibility override: `reduce-motion`, `high-contrast-ink`, `disable-dither` — a dithering CRT aesthetic is genuinely nauseating for some users; this is a shipping requirement, not a nicety.

**B. PS2-era world post stack (optional, per-project, off by default)**
- Low internal resolution (e.g. 640×480 → 1920×1080) with point-filtered upscale.
- Vertex snapping (quantize clip-space XY to a virtual grid) + affine texture mapping (disable perspective-correct interpolation) → authentic texture warping.
- 15/16-bit color quantization with ordered (Bayer 4×4) dithering in output space.
- Optional scanline/vignette/CRT mask pass. All as URP `ScriptableRendererFeature`s with a single ordered pass list in `Ps2Profile` asset.

**C. Stylized-but-modern world rendering** (the default, so any art style imports cleanly)
- URP forward+ with per-object render layers; toon ramp via Shader Graph but **never required** — a realistic FBX/GLB must look correct with zero material authoring. Materials are imported PBR-first; stylization is an additive override layer.
- Bloom (dual-filter), DoF (half-res, gather-based), color grading via LUT (volume-based), vignette, particles via VFX Graph.
- Volumetric lights: real volumetric fog for hero shots; billboard light-shaft cards for perf mode. Expose as a quality tier, not a hard dependency.

### 1.7 Performance envelope (target hardware: Ryzen 7 + RX 6600 8 GB + 32 GB)

| Scenario | Target | Notes |
|---|---|---|
| Editor idle, 1 avatar, 3 lights, grade+bloom | 1080p60, GPU < 7 ms | DoF off while scrubbing; half-res DoF when parked |
| Live performance (webcam + TTS + lipsync) | 1080p60, end-to-end motion→present < 40 ms | Tracking inference ≤ 12 ms at 256×256 input, 30 Hz tracking / 60 Hz render with pose interpolation |
| Offline render (master) | 1440p or 4K, 60 fps, any duration | Bounded by encode; PNG sequence + FFmpeg (AMF or x264 slow) at ~2–4× realtime at 1440p |
| 8 GB VRAM budget | ≤ 5.5 GB resident | 1 avatar (≤ 80 k tris, 4×4k textures), stage (≤ 500 k tris), post buffers, 2 s of 48 kHz audio |

---

## 2. Modular architecture

### 2.1 Process model

```
┌─────────────────────────────┐        gRPC / named pipe        ┌──────────────────────────────┐
│  OLiteatry.Shell (UI)       │  commands ▸  ◂ frames, stats    │  OLiteatry.Renderer (Unity)  │
│  uGUI + TMP, theme engine   │  (msgpack, 60 Hz telemetry)     │  scene, avatars, recorder    │
│  timeline, asset browser    │                                 │  headless-capable            │
└──────────────┬──────────────┘                                 └──────────────┬───────────────┘
               │  writes .oliteproj (JSON, atomic rename)                      │ writes takes/*.mp4|png
               ▼                                                               ▼
        ┌──────────────────────────────┐                          ┌──────────────────────────┐
        │ OLiteatry.Cli (headless)     │  CI / farm rendering     │  FFmpeg + WhisperX       │
        │ same Core, no UI             │─────────────────────────▸│  (subprocess boundary)   │
        └──────────────────────────────┘                          └──────────────────────────┘
```

*Why split?* Unsaved performance data is the most expensive thing in the product. A recording crash (driver reset, OOM, 20-minute render) must not take the editor with it. The shell owns truth on disk; the renderer is a **projection** that can be killed and respawned in < 2 s.

`OLiteatry.Cli` reuses `Core` and drives the *same* renderer in `-batchmode` with a deterministic time source — this is how we guarantee "what I previewed is what I render", and how CI produces golden frames nightly.

IPC: gRPC over a local named pipe (Windows) / UDS, `protobuf` for commands, `msgpack` for the 60 Hz telemetry stream. Commands are idempotent and versioned (`cmd_id`, `schema_version`) so a renderer restart can replay the last N commands to restore state.

### 2.2 Layers

```
┌───────────────────────────────────────────────────────────────────────┐
│ Shell (uGUI/TMP)        Timeline · Inspector · AssetBrowser · Studio  │
├───────────────────────────────────────────────────────────────────────┤
│ Application services   ProjectService · UndoService · LocService ·    │
│                        VoiceService · RenderQueue · PluginHost        │
├───────────────────────────────────────────────────────────────────────┤
│ Domain (OLiteatry.Core, engine-free .NET)                             │
│  TimelineModel · SceneGraph · AssetStore · PerformancePipeline ·      │
│  VisemeMapper · GestureDirector · LocCatalog · ProjectFormat          │
├───────────────────────────────────────────────────────────────────────┤
│ Engine adapters (Unity)   RenderHost · RigHost · RecorderHost ·       │
│                           TrackingHost · AudioHost · TextHost          │
├───────────────────────────────────────────────────────────────────────┤
│ Platform   Windows (primary) · Linux (secondary) · FFmpeg · ONNX RT   │
└───────────────────────────────────────────────────────────────────────┘
```

Dependency rule: **arrows point down only.** `Core` has zero references to `UnityEngine`. Any `using UnityEngine` in `OLiteatry.Core` fails the build (enforced by an analyzer + CI grep gate). This one rule is what makes D3/D4 real instead of aspirational.

### 2.3 Module contracts

| Module | Responsibility | Key interfaces | Thread |
|---|---|---|---|
| **Render** | Scene graph → pixels; quality tiers; post stack; color management (linear ACES-ish → sRGB out) | `IRenderHost`, `IPostStack`, `IQualityTier` | Main + RHI |
| **Rig & Anim** | Skeleton import/authoring, **auto-rig**, skin weights, blend shapes, keyframes, IK constraints, **stop-motion capture** | `IRigHost`, `ISkeleton`, `IWeightSolver`, `IStopMotionSession` | Main (jobs for weights) |
| **Camera & Transitions** | Multi-cam rigs, shot list, cuts, fades/wipes/pans, theatrical framing presets, follow/aim targets | `ICameraDirector`, `ITransition`, `IShot` | Main (timeline-evaluated) |
| **Audio & SFX** | Multi-track timeline, bus/gain, 3D attenuation, SFX library, import, **TTS client**, STT alignment | `IAudioEngine`, `ITtsProvider`, `IAlignmentProvider` | Audio DSP thread (SPSC ring → main) |
| **Loc / i18n** | String catalogs, fallback chains, font fallback, locale-aware formatting, voice registry, subtitle layout | `ILocCatalog`, `IFontResolver`, `IVoiceRegistry` | Any (immutable after load) |
| **AI / Procedural** | Viseme track build, prosody features, gesture director, blink/saccade/breath, additive blending | `IPerformancePipeline`, `IGestureDirector` | Deterministic, frame-sampled |
| **Asset & Project** | Import pipeline, content-addressed store, schema migration, thumbnails, provenance | `IAssetImporter`, `IProjectStore` | Worker pool |
| **Recorder** | Frame-accurate capture, alpha export, queue, naming, verification | `IRecorder`, `IEncodeProfile` | Render thread → encoder |
| **Plugin host** | Assembly load, API surface, sandboxing limits, capability grants | `ILiteatryPlugin` | Main |

### 2.4 Project format (the anti-lock-in contract)

`.oliteproj` is a **directory**:

```
MyShow.oliteproj/
├── project.json            # schema_version, engine_hint (ignored on load), settings
├── shots/                  # one file per shot: cameras, transitions, actor cues
├── performances/           # per-actor: audio ref, viseme bake ref, motion layers, seeds
├── localization/           # *.ftl catalogs, subtitle styles, voice registry
├── assets.index.sqlite     # asset metadata, hashes, tags, provenance
└── store/ab/cd/<sha256>    # content-addressed blobs (models, audio, textures)
```

Rules:
1. **No engine types in the schema.** `Transform` is `{pos:[x,y,z], rot_quat:[x,y,z,w], scale:[x,y,z]}` — not `Matrix4x4`, not Unity YAML.
2. `schema_version` is monotonic; `ProjectMigrator` has one migration per version, both directions tested where lossless. A project from v0.4 must open in v1.0 — a hard CI gate with golden fixtures.
3. Blobs are content-addressed → dedupe across projects, trivially shareable "asset packs", and reproducible builds.
4. Writes are atomic (temp + `rename`) and journaled; the shell can always recover to the last committed `project.json`.
5. `engine_hint` exists purely for rendering-fidelity warnings ("this shot used volumetric fog; Godot host renders an approximation").

### 2.5 Undo/redo & determinism

- **Command pattern**, not state snapshots: every mutation is a serializable `ICommand` with `Apply/Invert`. Undo stack persists to `undo.journal` so a crash doesn't eat the session.
- **Coalescing** by `(command_type, target_id)` within 400 ms for drags/sliders.
- **Determinism contract:** all procedural motion samples `noise(seed, t)` where `seed = sha256(project_id, actor_id, shot_id, take_id)[0..8]`. Same project + same build = identical frames. Verified by a golden-frame CI job (PSNR ≥ 50 dB, SSIM ≥ 0.999) at every PR touching rendering or motion.
- Frame clock is a **rational time base** (`frame = round(t * fps_num / fps_den)`), never float accumulation. 23.976/24/25/29.97/30/50/59.94/60 supported natively; drop-frame timecode handled in one place (`Timecode.cs`) and unit-tested.

### 2.6 Plugin system

- `ILiteatryPlugin` with a **semi-annual-stable** API (`ApiVersion = 1`), semantic versioned; breaking changes require a 2-minor deprecation window.
- Assemblies loaded into a collectible `AssemblyLoadContext`; unloadable without editor restart (this is why the plugin host lives in `Core`, not in a Unity assembly).
- Capability grants declared in `plugin.json`: `assets.read`, `render.hook`, `network.outbound` (TTS), `files.write`. Granted per-plugin by the user, displayed in a permissions panel — the only credible defence for a tool that loads third-party code.
- Netcode rule: plugins may read the scene, may not mutate engine internals; they mutate via `ICommand`s. Keeps undo and determinism intact.

### 2.7 Auto-rigging (be realistic about scope)

"Built-in auto-rigging" is the feature most likely to disappoint. Plan:

| Tier | What it does | Tech |
|---|---|---|
| **T1 Guided placement** | User drags ~12 joint handles onto the mesh (front+side views); we generate a humanoid skeleton, mirror symmetrically, fit limb lengths | Trivial, robust, ships first |
| **T2 Bone-heat weights** | Automatic skinning from the T1 skeleton via voxel heat diffusion (the Blender "bone heat" family of algorithms) with geodesic fallback | C++/Burst port or a small native lib; quality is very good for watertight meshes |
| **T3 Auto-detection (experimental)** | Landmark estimation from a rendered multi-view turntable (MediaPipe-class) to auto-place T1 handles | Optional, clearly labelled experimental |
| **Out of scope v1** | Quadruped/creature rigs, facial rig synthesis from a single photo | Documented as no |

Deliver T1+T2 with a weight-paint fallback brush; call T3 experimental in the UI. Overpromising here is how the issue tracker dies.

---

## 3. Procedural human idle motion (key feature)

### 3.1 Principles

1. **Never animate idleness as noise on a sine wave.** Real idle is a stack of *goal-directed* micro-behaviours (fixate, blink, shift weight) over a slow postural drift. Noise alone reads as "drunk robot."
2. **Speech and body are one system.** Breath resets at phrase boundaries; emphasis gestures land on stressed syllables; blinks cluster at utterance ends; gaze returns to camera during pauses.
3. **Everything is additive over an authored base.** Authors can supply a "performance base" (sitting, standing, nervous); procedural layer adds life without fighting it.
4. **Deterministic and resumable.** Seeded, frame-sampled, scrubbable. No `Random.Range` anywhere, ever.

### 3.2 Pipeline

```
        ┌──────────────┐   PCM (48 kHz mono, float32), clocked by AudioSettings.dspTime
        │ Audio source │──────────────┬─────────────────────────────────┐
        └──────────────┘              │                                 │
                                      ▼                                 ▼
                          ┌────────────────────┐            ┌─────────────────────┐
                          │  VisemeTrack       │            │  ProsodyAnalyzer    │
                          │  (baked or live)   │            │  RMS · f0 · rate ·  │
                          │  t → 15 visemes    │            │  pause map · stress  │
                          └─────────┬──────────┘            └──────────┬──────────┘
                                    │                                  │
                                    ▼                                  ▼
                          ┌────────────────────┐            ┌─────────────────────┐
                          │  FaceBlender       │            │  GestureDirector    │
                          │  viseme×weight +   │            │  state machine +    │
                          │  expression layer  │            │  seeded PRNG +      │
                          └─────────┬──────────┘            │  prosody weighting  │
                                    │                       └──────────┬──────────┘
                                    │                                  │
                                    │              ┌───────────────────┴──────────────┐
                                    │              ▼                                  ▼
                                    │      ┌───────────────┐                 ┌────────────────┐
                                    │      │ MicroLayer    │                 │ EmphasisLayer  │
                                    │      │ blink·saccade │                 │ beat gestures  │
                                    │      │ ·lips·brow    │                 │ nods·head tilts│
                                    │      └───────┬───────┘                 └───────┬────────┘
                                    │              │                                 │
                                    ▼              ▼                                 ▼
                          ┌───────────────────────────────────────────────────────────────┐
                          │  AdditivePoseComposer  (masks · weights · spring smoothing)    │
                          └───────────────────────────────┬───────────────────────────────┘
                                                          ▼
                          ┌───────────────────────────────────────────────────────────────┐
                          │  Rig constraints: two-bone IK · look-at · multi-aim · chest   │
                          └───────────────────────────────┬───────────────────────────────┘
                                                          ▼
                                      Humanoid pose + ARKit-52/VRM expression weights
```

### 3.3 Stages

**S1 — Audio ingress & clock.** Master clock = `AudioSettings.dspTime` (sample-accurate, immune to frame hitches). Video frames *sample* the clock; never the reverse. A ring buffer holds ≥ 200 ms of decoded audio; the pipeline reads `t_audio = t_frame - output_latency`, calibrated once per device.

**S2 — Viseme track.** Two paths, one output schema (`t_start, t_end, viseme_id, weight`):

- **Offline / precise (default for rendered scenes):** forced alignment (WhisperX-class, word-level) → per-locale G2P → phoneme timings → viseme set. Baked to `performance.visemes.json` on import, so playback and render never re-run alignment. Coarticulation applied as a 40–70 ms asymmetric smoothing window with dominance blending (a viseme 60 % in is 30 % out — mouths close slowly, open fast).
- **Live / low-latency (streaming TTS, mic):** provider timestamps (character/word level, when available) → G2P → viseme; plus an MFCC-based fallback (visible-speech classification from the PCM itself) when timestamps are absent. Latency budget in §3.6.

G2P licensing note: run G2P **out of process** (`espeak-ng`-class tools are GPL; permissive alternatives exist) so a copyleft binary never links into our Apache-2.0 assemblies. Same boundary rule as FFmpeg.

**S3 — Prosody features** (per 20 ms hop, then low-passed): RMS envelope, f0 (YIN/autocorrelation), voiced/unvoiced, syllable-nucleus detection, pause map (gaps > 120 ms), and a derived **stress score** per syllable (energy × duration × pitch slope). These are the *inputs to gesture intensity* — this is what makes motion feel tied to speech instead of decorrelated.

**S4 — GestureDirector (the actual "AI").** Not a neural net — a **weighted finite-state machine with prosody-conditioned transition priors and a seeded PRNG**. Rationale: interpretable, tunable per character, zero inference cost, deterministic.

```
states: {REST, LISTEN, SPEAK_CALM, SPEAK_EMPHATIC, THINK, LAUGH, WEARY}
transition prior P(s'|s)              // authored curve per character archetype
gate: prosody.energy, speech_rate, pause_age, since_last[gesture_class]
select: gesture = Categorical( P(g | state) · cooldown[g] · novelty[g] )
duration: D ~ LogNormal(μ_g, σ_g)      // clamped to [0.6 s, 4.5 s]
blend:    in/out via critically-damped spring (ζ=0.85, ω tuned per mass)
```

Cooldowns per class (head nod 1.8 s, weight shift 8 s, hand gesture 3.2 s) + a `novelty` penalty (exponential decay over the last 5 gestures) prevent the "same nod every two seconds" tell.

**S5 — MicroLayer.**

- **Blink:** inter-blink interval ~ LogNormal(median 4.0 s, σ 0.55), plus a 2× probability bump at utterance start/end and on high cognitive load (long pause while "thinking"); 8–12 % double blinks; on speech onset, suppress blinks during the first 300 ms of a phrase (people don't blink mid-word). Close 60–90 ms, open 120–180 ms, asymmetric.
- **Saccade/fixation:** fixation 220–450 ms, saccade 40–60 ms; target sampled from a small salience set (camera lens, listener face, own hands, horizon). Gaze returns to the lens within 400 ms of a pause starting — the single strongest "alive and present" cue.
- **Brow/lip micro:** brow flash on emphasis (30–120 ms), lip press on /m,b,p/ closures, nostril flare on breath in.
- **Breathing:** 0.22–0.32 Hz sine + 0.05 Hz drift; amplitude damped 30 % while speaking and **reset at pause boundaries** (audible-breath sync sells the illusion cheaply). Chest/spine scale + shoulder rise, 3-bone chain, never the whole torso.

**S6 — EmphasisLayer.** Beat gestures fired at syllable nuclei whose stress score exceeds a threshold; amplitude ∝ stress; head nod on falling pitch accents, tilt on rising ones; hand gesture class chosen by state (open palm for explanation, point for deixis). Everything blended as *offsets*, never absolute poses, so authored base animation survives.

**S7 — Composer & constraints.** Additive layers combine with per-region masks (head 1.0, chest 0.6, arms 0.35, legs 0.0 in seated mode). Final pass: two-bone IK for hands (keep elbows inside a natural cone), look-at with damping and a dead zone (2° — otherwise the head tracks noise), and a pelvis/COM stabilizer so weight shifts don't slide the feet.

### 3.4 Why layered-additive instead of one big model

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| Single end-to-end ML motion model | Most natural at its best | Nondeterministic, GPU-hungry, uneditable, untunable per character, license/weights unclear | No (v1) |
| Pure procedural noise | Trivial | Reads as drunk robot; no speech coupling | No |
| **Layered additive + prosody-conditioned FSM** | Deterministic, tunable per archetype, cheap (< 0.3 ms/frame CPU), editable in timeline | Needs taste in the defaults | **Yes** |
| Mocap idle clips + procedural micro | Very natural base | Clip repetition detectable; asset licensing; memory | Hybrid: allow clip as the *base* layer, procedural on top |

### 3.5 Determinism

One `MotionRng` per `(actor, shot, take)`, PCG32, seeded from the project hash. Any stochastic draw goes through it, in a fixed order per frame. Scrubbing backwards re-samples analytically (`noise(t)` functions are stateless — Perlin/simplex sampled at absolute `t`), and only *stateful* things (FSM state, spring velocities) are checkpointed every 12 frames so reverse-scrub converges within 0.2 s. Bake mode flattens the whole stack to a dense pose track for export.

### 3.6 Latency budget

**Live mode (streaming TTS + webcam), target < 250 ms perceived:**

| Stage | Budget |
|---|---|
| Mic capture + resample | 8 ms |
| Tracking inference (GPU, 30 Hz) | 12 ms |
| Retarget + solve | 3 ms |
| Audio ring buffer + viseme lookahead | 60 ms |
| Render + present (vsync 60) | 16 ms |
| **Total motion→pixels** | **~40 ms** |
| TTS request → first audio chunk (network, provider-dependent) | 300–900 ms |
| Jitter buffer before speech starts | 350 ms |
| **Total TTS→visible mouth movement** | **~0.7–1.4 s** — hide it with a "thinking" micro-state (blink, weight shift, inhale), which is exactly what humans do before speaking |

**Offline mode:** no realtime constraint; bake everything, render at 2× frame density for motion blur, encode with a slow preset.

### 3.7 QA for "does it look alive"

- **Metric 1:** blink rate within 8–25 /min over 60 s of speech (outside → flagged).
- **Metric 2:** gesture repetition — no identical gesture class twice within its cooldown; KL divergence of gesture distribution vs authored prior < 0.15.
- **Metric 3:** lip-sync correlation — viseme-energy vs audio-envelope cross-correlation ≥ 0.7 with ≤ 40 ms lag.
- **Human gate:** 10 blind 15 s clips, "does this look stiff / creepy / fine" — 2 of 3 raters must say "fine" before a release. Uncanny valley is not measurable by CI alone.

---

## 4. Localization architecture

### 4.1 Four independent layers

| Layer | Owns | Failure if conflated |
|---|---|---|
| **Strings** | UI copy, tooltips, errors, asset names | Concatenated translation → broken grammar |
| **Typography/layout** | Font fallback, MSDF atlases, RTL shaping, text expansion | German/Portuguese overflow destroys the parchment frames |
| **Voice** | Locale → provider voice + model + normalization rules | "Reading numbers in English with a pt-BR voice" |
| **Subtitles** | Cue segmentation, reading speed, line breaking | Unreadable 6-word-per-0.2 s cues |

### 4.2 Strings: Fluent (`.ftl`)

Choose **Fluent** over plain JSON/gettext because it handles plurals, gender, and inline markup without string surgery:

```ftl
# locales/pt-BR/ui.ftl
actor-count = { $n ->
    [one] {$n} ator
   *[other] {$n} atores
}
render-eta = Renderizando { $frame } de { $total } ({ NUMBER($pct, style: "percent") })
take-deleted = Take “{ $name }” excluído.
```

- **Key scheme:** `<area>.<component>.<purpose>` (`timeline.clip.delete`, `rig.autorig.failed`), never English sentences as keys.
- **Fallback chain:** `pt-BR → pt → en`, resolved once at load into a flat dictionary (O(1) lookups, immutable → thread-safe).
- **Locale ≠ language.** `zh-Hans` vs `zh-Hant`, `pt-BR` vs `pt-PT` are separate catalogs; pt-PT ships later and is not a fallback for pt-BR (spelling and voice differ materially).
- **No user-visible concatenation.** Anything assembled from parts is a parameterized message with a `NUMBER()`/`DATETIME()` formatter bound to the active locale (ICU rules, not `string.Format` with `CultureInfo.InvariantCulture` — a classic bug).
- **Pseudo-locale `en-XA`** (accented + 35 % expansion) in every dev build: catches truncation and hardcoded strings before translators ever see them. CI fails if a new `[LocKey]` attribute lacks an `en` entry.

### 4.3 Typography for a stylized UI

- **MSDF (multi-channel SDF) atlases** generated at build time per font, 32–48 px em, with a per-script atlas set. SDF is mandatory: the parchment UI scales 0.8×–1.6× with DPI changes and crisp outlines at all sizes.
- **Font chain:** `OLiteatry Serif` (display, OFL, Latin + Latin-Ext) → `Noto Serif` (Cyrillic/Greek) → `Noto Sans JP/KR/SC/TC` → `Noto Sans Arabic/Hebrew` → `Noto Sans` (fallback-of-last-resort). Resolved per *glyph*, not per string, so a single "Kiosk 東京" string renders correctly.
- **Dynamic atlas growth:** on-demand glyph add with a 2048×2048 atlas per (font, weight); evict LRU at 90 % occupancy and keep a "no-evict" band for glyphs used in the last 2 minutes. Avoids the classic TMP "atlas full → boxes" bug on CJK.
- **Shaping:** HarfBuzz (via a native bridge) for Arabic/Hebrew/Devanagari — TMP's built-in shaping covers Latin/CJK but not complex scripts. Gate it behind `TextHost.ResolveShaper(script)` so a build without the native lib still runs Latin locales.
- **Layout discipline:** all UI uses **auto-layout with elastic min/max**, never fixed pixel widths; text containers declare `overflow = shrink | wrap | ellipsis` explicitly. Test with de-DE (long compounds) and ru-RU (Cyrillic metric drift) as CI screenshot fixtures.

### 4.4 Voice & TTS per locale

```json
// localization/voices.registry.json
{
  "pt-BR": { "provider": "elevenlabs", "voice_id": "…", "model": "multilingual",
             "normalization": "pt-BR", "style": "theatrical", "speaking_rate": 0.98 },
  "en":    { "provider": "elevenlabs", "voice_id": "…", "model": "multilingual",
             "normalization": "en",    "fallbacks": ["piper:en_US-amy"] }
}
```

- **Voice is a project asset, not a global setting** — one scene can have a pt-BR narrator and an en antagonist.
- **Provider abstraction** (`ITtsProvider`) with at least two backends: a cloud one (ElevenLabs-class) and a local one (Piper/ONNX) so the OSS project is functional **without an API key**. This is a hard requirement for a GitHub-hosted tool: if the demo needs a paid key, nobody stars it.
- **Normalization before synthesis:** ICU-based number/date/currency/abbreviation expansion, acronym pronunciation overrides, SSML-ish break/pitch tags mapped per provider capability (capability matrix, not `if provider == …`).
- **Voice cloning = consent-first UX:** explicit consent checkbox, `voice_id` + consent record stored in the project manifest, and a hard block on cloning from an unverified sample. Non-negotiable; it is both an ethical and a ToS requirement, and it protects the project's reputation.

### 4.5 Subtitles

Generated from the same alignment used for lip-sync (one source of truth → subtitles can never drift from the mouth):

- Cue segmentation at sentence/pause boundaries, then split by **reading-speed constraints**: ≤ 42 chars/line, 2 lines max, ≤ 17 chars/s, min cue 1.0 s, max 7 s.
- Per-locale typographic rules: pt-BR uses `—` dialogue dashes and `«»`/`“”` per house style; CJK gets no inter-word spaces and different line-break rules (kinsoku).
- Outputs: `.srt`, `.vtt`, burned-in (via a subtitle track rendered in-engine, so styling matches the parchment theme), and a sidecar JSON for editors.
- **Translation pipeline:** source locale strings + timing → per-locale translation → re-align to the *localized* audio (timing must re-derive from the new TTS, not be copied — a translated line is never the same length).

### 4.6 Translator workflow

`weblate`-compatible (gettext/Fluent), with a `tools/loc` CLI that: extracts keys, validates Fluent syntax, reports untranslated %, generates `pseudo/en-XA`, and lints for placeholder drift (`{$n}` renamed → CI fail). Screenshot context for translators is auto-captured from the string's `[LocKey]`-annotated component (a small `ScreenshotHarness` scene) — this is what makes community translation actually good.

---

## 5. Open-source strategy & GitHub blueprint

### 5.1 Licensing matrix

| Component | License | Why |
|---|---|---|
| `src/**` (our code) | **Apache-2.0** | Patent grant (matters for codecs/rendering), corporate-contributor friendly, GPL-compatible direction |
| Bundled 3D/audio assets in `assets/` | **CC0-1.0** preferred; CC-BY-4.0 accepted with attribution file | Anything non-redistributable in `main` poisons the repo |
| Fonts | **OFL-1.1** | Required for embedding/redistribution; keep the OFL text next to the font |
| Example projects | **CC0** | Users must be able to copy them freely |
| Third-party binaries (FFmpeg, espeak-ng) | Not bundled in-repo; **downloaded at first run** with license display | Avoids GPL aggregation debates and repo bloat; user-facing license dialog |
| Trademark / logo (jester) | **All rights reserved**, separate trademark policy | Apache-2.0 covers code, not your identity; without this, forks can ship scam builds with your mascot |

If copyleft is a project goal instead, `GPL-3.0-or-later` for `src/**` is defensible — but then plugin authors must also be GPL, which halves the ecosystem. **Recommendation: Apache-2.0 + DCO.**

### 5.2 Repository layout

```
oliteatry/
├── README.md                     # what it is, 30 s demo gif, build in 3 commands
├── LICENSE                       # Apache-2.0
├── LICENSING.md                  # engine + asset + binary licensing, in plain language
├── CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md  GOVERNANCE.md
├── TRADEMARK.md
├── .reuse/dep5                   # REUSE/SPDX compliance metadata
├── docs/
│   ├── ARCHITECTURE.md           # this document
│   ├── adr/0001-engine-selection.md
│   ├── adr/0002-project-format.md
│   ├── rfcs/                     # proposal template + accepted RFCs
│   ├── manual/                   # user guide (localized, built with mdBook)
│   └── assets/provenance.csv     # every asset: path, author, license, source URL, sha256
├── src/
│   ├── OLiteatry.Core/           # engine-free domain (netstandard2.1 / net8.0)
│   │   ├── Timeline/  Project/  Assets/  Loc/  Voice/  Procedural/  Plugins/
│   ├── OLiteatry.Cli/            # headless render + batch tools
│   ├── OLiteatry.Unity/          # Unity host (asmdefs, no domain logic)
│   │   ├── Runtime/{Render,Rig,Audio,Tracking,Recorder,Text,UI}
│   │   └── Editor/
│   ├── OLiteatry.Themes/         # theme tokens + shaders (engine-agnostic JSON + HLSL)
│   └── OLiteatry.Plugin.Sdk/     # public API surface only
├── assets/                       # CC0/CC-BY models, stages, props, SFX, fonts
├── samples/                      # example .oliteproj (tiny, CC0)
├── tests/
│   ├── unit/  integration/  golden/   # golden = PSNR/SSIM frame comparisons
│   └── fixtures/projects/             # schema-migration fixtures vN → vN+1
├── tools/
│   ├── loc/  assets/  spdx/  release/  bench/
├── packages/                     # UPM manifests for modular install
└── .github/
    ├── workflows/{ci,build-windows,build-linux,golden-frames,loc-lint,release}.yml
    ├── ISSUE_TEMPLATE/{bug,feature,rfc,asset-submission}.yml
    └── CODEOWNERS
```

**CI gates (blocking):** build (Win+Linux) · `dotnet test` on `Core` · **no-`UnityEngine`-in-Core grep** · Fluent syntax + placeholder lint · REUSE/SPDX check on every new file · golden-frame PSNR on render/motion PRs · project-migration fixtures · `dotnet format`/analyzers · license-header check.

### 5.3 Asset provenance (the thing that sinks OSS tools)

Every file under `assets/` gets a row in `docs/assets/provenance.csv`: `path, title, author, license_spdx, source_url, sha256, modifications, voice/face consent (if applicable)`.

- CI rejects any asset without a provenance row, and any `sha256` mismatch.
- **VRM avatars carry their own license metadata** (VRM meta: avatar permission, commercial use, modification, redistribution, violent/sexual flags). The importer must *parse and display* it, and refuse to pack a redistribution-forbidden model into an exported sample project. This is a real, concrete feature — not legal theatre.
- SFX/music: CC0 only in `assets/`; CC-BY allowed with an `ATTRIBUTION.md` that the build copies into `Help → Licenses`.
- Never accept "found on the internet" assets in PRs. The asset-submission issue template forces a source URL and license, and the review checklist has a rejection script.

### 5.4 Contribution model

- **DCO** (`git commit -s`) instead of a CLA — lower friction, sufficient for Apache-2.0.
- **RFC process** for anything touching: project schema, plugin API, render pipeline, or licensing. Template: motivation → design → alternatives → migration → open questions. Accepted RFCs live in `docs/rfcs/` permanently (this is how the architecture stays coherent past 20 contributors).
- **CODEOWNERS** per subsystem; two approvals for schema/render/plugin-API changes.
- **Good-first-issue** seeded with: new locale catalogs, SFX asset packs, theme variants, docs, golden-frame fixtures. Localization and assets are the perfect on-ramp for non-C# contributors — and for a pt-BR-first project, that's a strategic advantage.
- **Conventional Commits + Changesets** → automated changelog and semantic versioning.
- Monthly "stage night": a community sample project shipped in `samples/`, which doubles as a regression test.

### 5.5 Release engineering

- Channels: `nightly` (every green main), `beta` (feature-complete milestones), `stable` (tagged, signed).
- Windows: signed MSIX or an Inno Setup installer + portable ZIP; Linux: AppImage + Flatpak manifest (which also forces us to keep the FFmpeg boundary clean).
- **Automatic updates must exist** for a tool this complex; use a signed manifest (Velopack-class) with delta updates and a rollback path.
- Crash reporting: opt-in, self-hosted (Sentry-compatible), PII-scrubbed, with the *project file never uploaded* — a written promise in the privacy doc.
- Reproducibility: pin the Unity editor version in `ProjectSettings/ProjectVersion.txt` + a `docs/BUILD.md` with the exact module list; CI caches `Library/` by lockfile hash.

### 5.6 Legal risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Engine EULA vs "open source" claims | Reputation, distro rejection | Explicit `LICENSING.md`; never call the *binary* open source; publish the source of 100 % of our code |
| ElevenLabs/ToS: shipping API keys, reselling | Account termination | BYO-key at runtime, keys in OS keychain, no key in repo/CI, usage shown to user |
| Voice cloning consent | Legal/ethical, PR disaster | Consent record + block unverified samples + document it |
| GPL binaries (FFmpeg, espeak) linked in | License contamination | Subprocess boundary only; downloaded at first run; no `dlopen` of GPL libs |
| Non-redistributable VRM/CC-BY-NC assets | Repo takedown | Provenance CI gate + importer refuses restricted models in samples |
| Font license (commercial serif) | Redistribution violation | OFL-only in repo, verified in CI |
| Patent (codecs, AR/pose estimation) | Injunction risk | Apache-2.0 patent grant; prefer patent-clean codecs (VP9/AV1/ProRes via FFmpeg); document |

---

## 6. Roadmap

Sized for a small team (1–3 FTE + community). Each milestone ends in a **demoable artifact**, not a merged PR pile.

| Milestone | Scope | Exit criteria (verifiable) |
|---|---|---|
| **M0 — Skeleton (wks 0–6)** | Repo, CI, `Core` timeline model, project format v0, shell/renderer split, theme engine v0 | Open app → parchment UI → import VRM → render 10 s PNG sequence via CLI. Golden-frame CI green |
| **M1 — Stage & cameras (wks 6–14)** | Scene graph, asset store, 3-point lighting, multi-cam, cuts + fades/wipes, PS2 post stack, quality tiers | 3-camera 60 s scene with 4 cuts, exported 1080p60 |
| **M2 — Performance (wks 14–24)** | Auto-rig T1+T2, keyframes, stop-motion capture with onion skin, webcam face tracking → blendshapes | Auto-rig an unrigged OBJ in < 3 min; live tracking at 30 Hz; 30 s stop-motion sequence |
| **M3 — Sound (wks 24–32)** | Multi-track audio, SFX library, TTS provider interface + ElevenLabs adapter + local Piper adapter, viseme bake, subtitle export | Assign pt-BR TTS to an actor → lip-sync within 40 ms, `.srt` exported, no network needed in local mode |
| **M4 — The key feature (wks 32–42)** | Procedural pipeline: prosody, gesture FSM, micro-layer, additive composer, per-character archetypes, determinism bake | Blind human test: 2/3 raters rate 15 s idle-speech clips "natural", no repetition tell |
| **M5 — Localization (wks 42–48)** | Fluent catalogs, pt-BR + en complete, font fallback chains, pseudo-loc, Weblate hookup, per-locale voices | pt-BR/en UI 100 % translated, de-DE pseudo-test clean, CJK string renders correctly |
| **M6 — Production hard (wks 48–56)** | Recorder profiles (ProRes/PNG master + AMF realtime), alpha export, plugin host + SDK v1, crash recovery, updater | 5-min 1440p scene renders unattended; plugin sample ships; crash during render loses no data |
| **M7 — v1.0 (wks 56–64)** | Perf pass, docs/manual, installer signing, governance docs, 3 sample projects, localization of docs | Tag `v1.0.0`, portable + installer builds, `docs/` complete, 0 P0 bugs for 2 weeks |

**Deferred (post-1.0, documented as "no"):** full body mocap from video, neural facial rig synthesis, multiplayer/live audience, mobile/VR targets, cloud render farm, creature rigging.

**Team shape if funded:** 1 render/graphics, 1 tools/UI (C#), 1 audio/AI pipeline, 0.5 technical writer + localization, 0.5 community/DevRel. Part-time QA via the M-monthly stage-night fixtures.

---

## 7. Appendices

### A. Core interfaces (engine-free, stable surface)

```csharp
// OLiteatry.Core — no UnityEngine reference permitted
public interface IPerformancePipeline {
    void Prepare(PerformanceAsset asset, MotionSeed seed, IClock clock);
    void Sample(double timeSeconds, ref PoseBuffer pose, ref ExpressionBuffer face);
    void Bake(double from, double to, double step, IPoseSink sink);
}

public interface ITtsProvider : IAsyncDisposable {
    Task<TtsSession> OpenAsync(VoiceSpec voice, CancellationToken ct);
    IAsyncEnumerable<AudioChunk> StreamAsync(TtsRequest request, CancellationToken ct);
    bool SupportsTimestamps { get; }
}

public interface IAlignmentProvider {           // whisperx | MFA | provider timestamps
    Task<VisemeTrack> AlignAsync(AudioRef audio, string locale, CancellationToken ct);
}

public interface IProjectStore {
    ProjectManifest Load(string path);
    void Commit(ProjectManifest manifest, IReadOnlyList<ICommand> commands);  // atomic
    IReadOnlyList<int> SupportedSchemaVersions { get; }
}

public interface ILocCatalog {
    string Get(string key, IReadOnlyDictionary<string, object?>? args = null);
    string Format(LocaleId locale, string key, params object[] args);
}
```

### B. Shot schema fragment

```json
{
  "schema_version": 1,
  "id": "shot_0003",
  "duration": 12.5,
  "camera": { "rig": "cam_b", "focal_mm": 35, "aperture": 2.8, "do_nothing_hack": false },
  "transition_in": { "type": "wipe", "duration": 0.6, "easing": "ease_in_out", "angle_deg": 12 },
  "performances": [{
    "actor": "jester_01",
    "audio": "store/ab/cd/…audiohash",
    "visemes": "performances/jester_01/shot_0003.visemes.json",
    "motion": { "archetype": "theatrical", "intensity": 0.72,
                "seed": "9f2c…a1", "layers": ["idle","micro","emphasis","lookat"] }
  }],
  "post": { "profile": "ps2_purple", "bloom": 0.35, "grade_lut": "themes/luts/dusk.cube" }
}
```

### C. Glossary

**Viseme** — visual mouth shape class (15 in the Oculus set, 52 ARKit blendshapes upstream). **Prosody** — pitch/energy/rhythm of speech. **Bake** — flatten procedural/streamed data into a dense track for deterministic playback. **MSDF** — multi-channel signed distance field font atlas. **DCO** — Developer Certificate of Origin. **RLS** — reduced life-like state: the tiny behaviours that make a character read as alive.

---

*Open questions for the RFC queue: (1) do we ship a WebGPU/secondary Web export? (2) is Scene Graph a DAG (instancing) or a tree (simplicity) — leaning tree + explicit instancing nodes; (3) should stop-motion mode support external camera capture (DSLR tether) in v1 or v1.2?*
