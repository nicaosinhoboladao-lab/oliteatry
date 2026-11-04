# Third-party software

| Component | Version | Licence | Use |
|---|---|---|---|
| three.js | 0.160.1 | MIT | 3D renderer (`src/renderer/vendor/three.module.js`, vendored for offline use) |
| three.js addons | 0.160.1 | MIT | GLTF/FBX/OBJ/MTL/STL/PLY/Collada loaders, TransformControls, OrbitControls (`src/renderer/vendor/addons.module.js`, vendored) |
| @pixiv/three-vrm | 3.5.5 | MIT | VRM avatar loading (`src/renderer/vendor/three-vrm.module.js`, vendored) |
| fflate | bundled in three addons | MIT | FBX zlib decompression (bundled) |
| esbuild | 0.28.x | MIT | author-time bundling of the vendored modules (`npm run vendor`) |
| Electron | 33.x | MIT | Desktop shell, window, file dialogs |
| electron-builder | 25.x | MIT | Windows packaging |
| vitest | 2.x | MIT | Unit tests |

Fonts are **not** bundled: the UI uses the host system stack
(`Palatino Linotype`, `Book Antiqua`, `Segoe UI`, `Cascadia Mono`), so no font licence applies.

There are no bundled 3D models, textures, avatars, voices or music. The stage, the character and
the voice are generated procedurally at runtime.
