import * as THREE from './vendor/three.module.min.js';
import {
  BUILDINGS, COMMAND_TIERS, ORBITAL_SURVEY, RESOURCES, UNITS, MAP_WIDTH, MAP_DEPTH, MAP_MIN_X, MAP_MAX_X, MAP_MIN_Z, MAP_MAX_Z,
  FOG_WIDTH, FOG_DEPTH, WALL_LENGTH, buildingFootprint, distance, highlightedMines, inSight, isBlueprint, maxBuildingHealth, orbitalVision, randomFrom, unitHitRadius, unitTask,
} from './world.mjs';
import { STANCE } from './diplomacy.mjs';

import { buildingModel, fallenUnitModel, material, primitive, unitModel } from './models.mjs';
import { TERRAIN_DETAIL_SIZE, blendTerrainColor, terrainBiomes, terrainDetailPixels, terrainPaint } from './terrain-visuals.mjs';
import { ATTACK_BORDER_COLOR, ATTACK_BORDER_INNER, ATTACK_BORDER_RADIUS, TERRITORY_FOG_LIMIT } from './territory.mjs';

const SCENERY_CHUNK_SIZE = 60;
const TERRAIN_CELL_SIZE = 0.9;
const PINES_URL = new URL('./assets/models/pines.json', import.meta.url).href;
const TERRAIN_TEXTURES = {
  mountainSurface: new URL('./assets/terrain/mountain.jpg', import.meta.url).href,
  crystalSurface: new URL('./assets/terrain/crystal.jpg', import.meta.url).href,
  grassSurface: new URL('./assets/terrain/grass.jpg', import.meta.url).href,
  forestSurface: new URL('./assets/terrain/forest.jpg', import.meta.url).href,
  desertSurface: new URL('./assets/terrain/desert.jpg', import.meta.url).href,
};
const emptySurface = new THREE.DataTexture(new Uint8Array(4), 1, 1);
emptySurface.needsUpdate = true;

function grassTuftGeometry() {
  const vertices = [];
  for (const [index, angle] of [0, 2.1, 4.2].entries()) {
    const x = Math.cos(angle);
    const z = Math.sin(angle);
    const a = [-z * 0.035, 0, x * 0.035];
    const b = [z * 0.035, 0, -x * 0.035];
    const tip = [x * 0.12, 0.21 + index * 0.025, z * 0.12];
    vertices.push(...a, ...b, ...tip, ...a, ...tip, ...b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function glowTexture(size = 32) {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4;
      const fade = Math.max(0, 1 - Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5) * 2);
      pixels.set([255, 255, 255, Math.round(255 * fade ** 1.7)], index);
    }
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

const softTexture = glowTexture();
const shadowGeometry = new THREE.PlaneGeometry(2, 2);
const MIN_ZOOM = 0.085;
const DUST_COUNT = 260;
const DUST_LIFETIME = 1.4;

// Pooled dust puffs kicked up behind moving vehicles; each drifts up and fades as it ages.
function createDust() {
  const geometry = new THREE.BufferGeometry();
  const position = new Float32Array(DUST_COUNT * 3);
  const color = new Float32Array(DUST_COUNT * 4);
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 4));
  const material = new THREE.PointsMaterial({
    map: softTexture, vertexColors: true, transparent: true, depthWrite: false, size: 20, sizeAttenuation: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  // Draw after the translucent terrain overlays so they do not hide the puffs; solid geometry still occludes.
  points.renderOrder = 6;
  return { points, position, color, life: new Float32Array(DUST_COUNT), drift: new Float32Array(DUST_COUNT * 3), next: 0, clock: performance.now() };
}

const shadowMaterial = new THREE.MeshBasicMaterial({ map: softTexture, color: '#0b1520', transparent: true, opacity: 0.72, depthWrite: false });

function contactShadow(radius) {
  const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(radius * 1.32, radius, 1);
  return shadow;
}

function octagon(color, radius, opacity) {
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 32),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

function roverWorkEffect() {
  const group = new THREE.Group();
  const pulse = new THREE.Mesh(new THREE.RingGeometry(0.64, 0.76, 24),
    new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  pulse.rotation.x = -Math.PI / 2;
  pulse.position.y = 0.14;
  const sparks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 7);
  sparks.frustumCulled = false;
  sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(pulse, sparks);
  group.visible = false;
  return { group, pulse, sparks, particle: new THREE.Object3D(), work: null };
}

function animateRoverWork(effect, work, time, heading) {
  effect.group.visible = Boolean(work);
  if (!work) return;
  const harvesting = work === 'harvest';
  if (effect.work !== work) {
    const color = harvesting ? '#ccf58a' : '#78e6ff';
    effect.pulse.material.color.set(color);
    effect.sparks.material.color.set(color);
    effect.work = work;
  }
  effect.group.rotation.y = heading;
  const wave = (time * (harvesting ? 1.55 : 2.25)) % 1;
  effect.pulse.scale.setScalar(1 + wave * (harvesting ? 0.64 : 0.38));
  effect.pulse.material.opacity = 0.82 * (1 - wave);
  const { sparks, particle } = effect;
  for (let index = 0; index < sparks.count; index++) {
    const phase = (wave + index / sparks.count) % 1;
    const angle = index * 2.4;
    const spread = harvesting ? 0.13 + phase * 0.9 : 0.28 + phase * 0.23;
    const height = harvesting ? 0.27 + Math.sin(phase * Math.PI) * 0.81 : 0.25 + phase * 1.2;
    particle.position.set(Math.cos(angle) * spread, height, 0.74 + Math.sin(angle) * spread);
    particle.rotation.set(phase * 2, angle, phase);
    const size = 0.035 + Math.sin(phase * Math.PI) * 0.11;
    particle.scale.set(size, harvesting ? size : size * 1.75, size);
    particle.updateMatrix();
    sparks.setMatrixAt(index, particle.matrix);
  }
  sparks.instanceMatrix.needsUpdate = true;
}

function disposeRoverWork(effect) {
  if (!effect) return;
  effect.group.traverse((item) => {
    if (!item.isMesh) return;
    item.geometry.dispose();
    item.material.dispose();
    if (item.isInstancedMesh) item.dispose();
  });
}

export class WorldView {
  constructor(canvas, overlay, onFrameChange) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.onFrameChange = onFrameChange;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#111f2a');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.17;
    this.camera = new THREE.OrthographicCamera(-20, 20, 16, -16, 0.1, 220);
    this.focus = new THREE.Vector3(-0.8, 0, -1.6);
    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.cameraDirection = new THREE.Vector3(26, 45, 34);
    this.zoom = 1;
    this.scene.add(new THREE.HemisphereLight('#c7e4fe', '#473746', 1.55));
    const sun = new THREE.DirectionalLight('#ffe1b2', 2.8);
    sun.position.set(-42, 28, 18);
    this.scene.add(sun);
    const atmosphere = new THREE.DirectionalLight('#8cc3ff', 0.68);
    atmosphere.position.set(24, 8, -30);
    this.scene.add(atmosphere);
    this.static = new THREE.Group();
    this.entities = new THREE.Group();
    this.remains = new THREE.Group();
    this.scene.add(this.static, this.entities, this.remains);
    this.entityModels = new Map();
    this.remainsModels = new Map();
    this.buildingNamesVisible = false;
    this.gatherableInstances = new Map();
    this.pineModels = [];
    this.groveMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 });
    this.harvestedCount = 0;
    this.hiddenInstance = new THREE.Matrix4().makeScale(0, 0, 0);
    this.labels = [];
    this.ventSites = [];
    this.ghost = null;
    this.ghostMaterial = new THREE.MeshBasicMaterial({ color: '#a6f4d6', transparent: true, opacity: 0.48, depthWrite: false });
    this.preferredBiome = { value: -1 };
    this.depositGuideIds = { available: new Set(), preferred: new Set() };
    this.fogTexture = new THREE.DataTexture(null, FOG_WIDTH, FOG_DEPTH, THREE.RedFormat);
    this.fogTexture.magFilter = THREE.LinearFilter;
    this.fogTexture.minFilter = THREE.LinearFilter;
    this.territoryTexture = new THREE.DataTexture(null, FOG_WIDTH, FOG_DEPTH);
    this.terrainDetail = new THREE.DataTexture(terrainDetailPixels(), TERRAIN_DETAIL_SIZE, TERRAIN_DETAIL_SIZE);
    this.terrainDetail.wrapS = this.terrainDetail.wrapT = THREE.RepeatWrapping;
    this.terrainDetail.generateMipmaps = true;
    this.terrainDetail.minFilter = THREE.LinearMipmapLinearFilter;
    this.terrainDetail.magFilter = THREE.LinearFilter;
    this.terrainDetail.anisotropy = Math.min(8, this.renderer.capabilities?.getMaxAnisotropy() ?? 1);
    this.terrainDetail.needsUpdate = true;
    this.terrainSurfaces = Object.fromEntries(Object.keys(TERRAIN_TEXTURES).map((name) => [name, { value: emptySurface }]));
    this.terrainSeedOffset = { value: new THREE.Vector2() };
    this.attackBorder = { value: new THREE.Vector3() };
    const routeLine = (color) => {
      const line = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
      line.frustumCulled = false;
      this.scene.add(line);
      return line;
    };
    this.route = routeLine('#a6ebfb');
    this.rallyRoute = routeLine('#ffc887');
    this.harvestPatrolRoute = routeLine('#bde88c');
    this.harvestPatrolRoute.visible = false;
    this.constructionPreview = routeLine('#a6f4d6');
    this.blockedConstructionPreview = routeLine('#ff887e');
    this.blueprintOutlines = routeLine('#8bd6ed');
    this.blueprintOutlines.visible = false;
    this.blueprintLabels = new Map();
    this.recommendedDepositMarkers = routeLine('#87ffe3');
    this.recommendedDepositMarkers.visible = false;
    this.availableDepositMarkers = routeLine('#ffcf83');
    this.availableDepositMarkers.visible = false;
    this.shots = routeLine('#ffdca9');
    this.shots.visible = false;
    this.shellTrails = routeLine('#ffb15c');
    this.shellTrails.visible = false;
    this.shellHeads = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
      color: '#ffdd9a', size: 16, sizeAttenuation: false, map: softTexture, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.shellHeads.frustumCulled = false;
    this.shellHeads.visible = false;
    this.scene.add(this.shellHeads);
    this.missionMarker = routeLine('#ffd890');
    this.surveyPlan = routeLine('#ffd890');
    this.orbitalVision = routeLine('#95e9ff');
    this.defenseRange = routeLine('#ffa87e');
    this.mineMarkers = routeLine('#ffcf83');
    this.orbitalVision.material.opacity = 0.60;
    for (const layer of [this.missionMarker, this.surveyPlan, this.orbitalVision, this.defenseRange, this.mineMarkers]) layer.visible = false;
    this.vapor = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({
      color: '#b9dbe8', map: softTexture, transparent: true, opacity: 0.44, size: 26, depthWrite: false,
    }));
    this.vapor.frustumCulled = false;
    this.scene.add(this.vapor);
    this.dust = createDust();
    this.scene.add(this.dust.points);
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  loadTerrainTextures() {
    const loader = new THREE.TextureLoader();
    for (const [name, url] of Object.entries(TERRAIN_TEXTURES)) {
      loader.load(url, (texture) => {
        // The terrain shader blends these colors after the output color-space conversion.
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = this.terrainDetail.anisotropy;
        this.terrainSurfaces[name].value = texture;
      }, undefined, () => console.warn('A terrain texture could not load. Using the procedural surface.'));
    }
  }

  async loadTreeModels() {
    try {
      const response = await fetch(PINES_URL);
      if (!response.ok) throw new Error(`Tree model request returned ${response.status}`);
      const loader = new THREE.BufferGeometryLoader();
      this.pineModels = (await response.json()).map((model) => {
        const geometry = loader.parse(model);
        geometry.computeVertexNormals();
        return geometry;
      });
    } catch (error) {
      console.warn('The pine models could not load. Using the original trees.', error);
    }
  }

  resize() {
    const { clientWidth, clientHeight } = this.canvas;
    if (!clientWidth || !clientHeight) return;
    const pixelBudget = Math.max(1, Math.sqrt(6_000_000 / (clientWidth * clientHeight)));
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2, pixelBudget);
    if (pixelRatio !== this.pixelRatio) {
      this.renderer.setPixelRatio(pixelRatio);
      this.pixelRatio = pixelRatio;
    }
    this.renderer.setSize(clientWidth, clientHeight, false);
    const aspect = clientWidth / clientHeight;
    const vertical = aspect < 1.05 ? 23 : 17;
    this.camera.left = -vertical * aspect;
    this.camera.right = vertical * aspect;
    this.camera.top = vertical;
    this.camera.bottom = -vertical;
    this.camera.zoom = this.zoom;
    this.camera.updateProjectionMatrix();
    this.updateCamera();
  }

  updateCamera() {
    // Zoomed far out, pull the camera back along the same angle so the whole map stays inside its depth range.
    const pullback = Math.max(1, 0.75 / (this.zoom ?? 1));
    this.camera.position.copy(this.focus).addScaledVector(this.cameraDirection, pullback);
    this.camera.far = 220 * pullback;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.focus);
    this.camera.updateMatrixWorld();
    this.onFrameChange?.();
  }

  center(x, z) {
    this.focus.set(THREE.MathUtils.clamp(x, MAP_MIN_X + 3, MAP_MAX_X - 3),
      0, THREE.MathUtils.clamp(z, MAP_MIN_Z + 3, MAP_MAX_Z - 3));
    this.updateCamera();
  }

  pan(x, y) {
    const along = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const back = new THREE.Vector3(-along.z, 0, along.x);
    this.center(this.focus.x + along.x * x + back.x * y, this.focus.z + along.z * x + back.z * y);
  }

  setZoom(value, cursor) {
    // The far end shows the entire map on one screen, like a large minimap.
    const zoom = THREE.MathUtils.clamp(value, MIN_ZOOM, 2.9);
    if (cursor && zoom !== this.zoom) {
      this.setPointerRay(cursor.clientX, cursor.clientY);
      const { origin, direction } = this.ray.ray;
      // Orthographic rays stay parallel, so a point on the ground plane anchors any terrain height.
      const groundDistance = -origin.y / direction.y;
      const anchorX = origin.x + direction.x * groundDistance;
      const anchorZ = origin.z + direction.z * groundDistance;
      // Zooming in recentres on the point under the cursor; zooming out keeps that point under the cursor.
      const shift = zoom > this.zoom ? 1 : 1 - this.zoom / zoom;
      this.center(this.focus.x + (anchorX - this.focus.x) * shift,
        this.focus.z + (anchorZ - this.focus.z) * shift);
    }
    this.zoom = zoom;
    // In the whole-map overview, resource labels would pile up; keep only home and structure labels.
    this.overlay.classList.toggle('map-labels--overview', zoom < 0.4);
    this.resize();
  }

  resetCamera() {
    if (!this.world) return;
    this.center(this.world.home.x - 0.8, this.world.home.z - 1.6);
    this.setZoom(1);
  }

  setWorld(world) {
    this.world = world;
    const terrainRandom = randomFrom(world.seed + 2537);
    this.terrainSeedOffset.value.set(terrainRandom() * 83, terrainRandom() * 83);
    this.updateTerritory();
    this.resetCamera();
    this.static.traverse((node) => {
      if (node.userData.ownedGeometry) node.geometry.dispose();
      if (node.userData.ownedMaterial) node.material.dispose();
      if (node.isInstancedMesh) node.dispose();
    });
    this.static.clear();
    for (const model of this.entityModels.values()) disposeRoverWork(model.workEffect);
    this.entities.clear();
    this.entityModels.clear();
    this.remains.clear();
    this.remainsModels.clear();
    this.overlay.replaceChildren();
    this.blueprintLabels.clear();
    this.blueprintOutlines.visible = false;
    this.labels = [];
    this.ventSites = [];
    this.gatherableInstances.clear();
    this.harvestedCount = 0;
    this.defensePreview = null;
    this.showSitingGuide(null, []);
    for (const layer of [this.missionMarker, this.surveyPlan, this.orbitalVision, this.defenseRange, this.mineMarkers]) {
      layer.visible = false;
      layer.userData.markerKey = null;
    }
    this.markedFactions = new Set();
    this.makeTerrain();
    this.makeLandscape();
    this.makeLandingApron();
    for (const deposit of world.deposits) this.makeDeposit(deposit);
    this.vapor.geometry.dispose();
    this.vapor.geometry = new THREE.BufferGeometry();
    this.vapor.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.ventSites.length * 18), 3)
      .setUsage(THREE.DynamicDrawUsage));
    this.vapor.visible = this.ventSites.length > 0;
    for (const outpost of world.outposts) {
      const model = buildingModel('outpost');
      model.position.set(outpost.x, world.elevation(outpost.x, outpost.z), outpost.z);
      this.static.add(model);
      this.makeLabel(outpost, outpost.name, 'Contact', 'outpost', 1.8);
      model.userData.site = outpost;
    }
    this.makeLabel(world.home, 'Command Center', 'Home base', 'home', 2.88, true);
  }

  setFog(fog) {
    this.fogTexture.image.data = fog.shade;
    this.fogTexture.needsUpdate = true;
  }

  updateTerritory() {
    const { pixels } = this.world.territoryMap;
    if (this.territoryTexture.image.data === pixels) return;
    this.territoryTexture.image.data = pixels;
    this.territoryTexture.needsUpdate = true;
  }

  setBuildingNames(visible) { this.buildingNamesVisible = visible; }

  fogMaterial(options, terrainGuide = false) {
    const material = new THREE.MeshStandardMaterial(options);
    const fogTint = 'gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.055, 0.085, 0.08), texture2D(sightFog, vSightUv).r);';
    material.onBeforeCompile = (shader) => {
      shader.uniforms.sightFog = { value: this.fogTexture };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vSightUv;')
        .replace('#include <project_vertex>', `
          vec4 sightPosition = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            sightPosition = instanceMatrix * sightPosition;
          #endif
          vSightUv = ((modelMatrix * sightPosition).xz - vec2(${MAP_MIN_X}.0, ${MAP_MIN_Z}.0))
            / vec2(${MAP_WIDTH}.0, ${MAP_DEPTH}.0);
          #include <project_vertex>
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vSightUv;\nuniform sampler2D sightFog;');
      if (terrainGuide) {
        shader.uniforms.preferredBiome = this.preferredBiome;
        shader.uniforms.territoryMap = { value: this.territoryTexture };
        shader.uniforms.terrainDetail = { value: this.terrainDetail };
        Object.assign(shader.uniforms, this.terrainSurfaces);
        shader.uniforms.terrainSeedOffset = this.terrainSeedOffset;
        shader.uniforms.attackBorder = this.attackBorder;
        const groundVaryings = '\nvarying vec3 vBiomeWeightsA;\nvarying vec3 vBiomeWeightsB;\nvarying float vGroundHeight;\nvarying vec3 vGroundNormal;';
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute vec3 biomeWeightsA;\nattribute vec3 biomeWeightsB;' + groundVaryings)
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBiomeWeightsA = biomeWeightsA;\nvBiomeWeightsB = biomeWeightsB;\nvGroundHeight = transformed.y;\nvGroundNormal = normal;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float preferredBiome;\nuniform sampler2D territoryMap;' + groundVaryings + `
            uniform vec3 attackBorder;
            uniform sampler2D terrainDetail;
            uniform sampler2D mountainSurface;
            uniform sampler2D crystalSurface;
            uniform sampler2D grassSurface;
            uniform sampler2D forestSurface;
            uniform sampler2D desertSurface;
            uniform vec2 terrainSeedOffset;
            float biomeWeight(float biome) {
              vec3 first = 1.0 - step(0.5, abs(vec3(0.0, 1.0, 2.0) - biome));
              vec3 second = 1.0 - step(0.5, abs(vec3(3.0, 4.0, 5.0) - biome));
              return dot(vBiomeWeightsA, first) + dot(vBiomeWeightsB, second);
            }
            vec4 claimAt(vec2 uv) {
              if (any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0)))) return vec4(0.0);
              return texture2D(territoryMap, uv);
            }
            float paintDot(vec2 cell) {
              vec3 samplePoint = fract(vec3(cell.xyx) * 0.1031);
              samplePoint += dot(samplePoint, samplePoint.yzx + 33.33);
              return fract((samplePoint.x + samplePoint.y) * samplePoint.z);
            }
            float paintNoise(vec2 point) {
              vec2 cell = floor(point);
              vec2 t = smoothstep(vec2(0.0), vec2(1.0), fract(point));
              float nearRow = mix(paintDot(cell), paintDot(cell + vec2(1.0, 0.0)), t.x);
              float farRow = mix(paintDot(cell + vec2(0.0, 1.0)), paintDot(cell + vec2(1.0)), t.x);
              return mix(nearRow, farRow, t.y);
            }
          `)
          .replace('#include <dithering_fragment>', `
            vec2 surface = vSightUv * vec2(${MAP_WIDTH}.0, ${MAP_DEPTH}.0);
            vec2 brush = vec2(dot(surface, vec2(0.18, 0.24)), dot(surface, vec2(-0.37, 0.43)));
            float paint = paintNoise(brush);
            vec2 tiling = (surface + vec2(paint * 0.67, paint * 0.45)) / 11.0;
            vec4 detail = texture2D(terrainDetail, tiling);
            vec4 crossed = texture2D(terrainDetail, mat2(0.78, 0.63, -0.63, 0.78) * tiling * 0.68 + vec2(0.25, 0.71));
            float plains = biomeWeight(${terrainBiomes.indexOf('plains')}.0);
            float forest = biomeWeight(${terrainBiomes.indexOf('forest')}.0);
            float green = plains + forest;
            float sand = biomeWeight(${terrainBiomes.indexOf('desert')}.0);
            float ridge = 1.0 - clamp(dot(vBiomeWeightsA + vBiomeWeightsB, vec3(1.0)), 0.0, 1.0);
            float mountain = biomeWeight(${terrainBiomes.indexOf('mountain')}.0);
            float stone = biomeWeight(${terrainBiomes.indexOf('volcanic')}.0) + biomeWeight(${terrainBiomes.indexOf('crystal')}.0);
            float blades = (detail.r - 0.5) + 0.44 * (crossed.r - 0.5);
            float ripples = mix(detail.g, crossed.g, 0.20) - 0.5;
            float fissures = mix(detail.b, crossed.b, 0.24) - 0.5;
            float grit = detail.a - 0.5;
            vec2 clearingUv = surface + terrainSeedOffset;
            float clearing = paintNoise(clearingUv * 0.23) * 0.64 + paintNoise(clearingUv * 0.52) * 0.23
              + paintNoise(clearingUv * 1.72) * 0.13 + blades * 0.052 + forest * 0.085;
            float edgeWidth = clamp(fwidth(clearing) * 0.75, 0.009, 0.048);
            float grassCover = smoothstep(0.415 - edgeWidth, 0.415 + edgeWidth, clearing);
            float exposed = green * (1.0 - grassCover);
            vec3 dirt = mix(vec3(0.38, 0.24, 0.13), vec3(0.60, 0.435, 0.28), paint);
            dirt *= 0.98 + fissures * 0.71 + grit * 0.68;
            gl_FragColor.rgb *= 0.98 + (paint - 0.5) * 0.13 + blades * green * 0.97
              + ripples * sand * 0.56 + fissures * stone * 0.85 + grit * 0.38;
            vec3 surfaceNormal = normalize(vGroundNormal);
            float light = smoothstep(-0.45, 0.90, dot(surfaceNormal, normalize(vec3(-0.76, 0.50, 0.33))));
            vec2 tileDx = dFdx(tiling);
            vec2 tileDy = dFdy(tiling);
            vec2 sandUv = (mat2(0.95, 0.31, -0.31, 0.95) * surface + vec2(paint * 0.9, paint * 2.5)) / 14.5;
            vec2 sandDx = dFdx(sandUv);
            vec2 sandDy = dFdy(sandUv);
            vec4 meadow = plains > 0.002 ? textureGrad(grassSurface, tiling * 0.87, tileDx * 0.87, tileDy * 0.87) : vec4(0.0);
            vec4 litter = forest > 0.002 ? textureGrad(forestSurface, tiling + vec2(0.21, 0.54), tileDx, tileDy) : vec4(0.0);
            vec4 windblown = sand > 0.002 ? textureGrad(desertSurface, sandUv, sandDx, sandDy) : vec4(0.0);
            vec3 bakedWeights = vec3(plains * meadow.a, forest * litter.a, sand * windblown.a);
            vec3 bakedGround = meadow.rgb * bakedWeights.x + litter.rgb * bakedWeights.y + windblown.rgb * bakedWeights.z;
            float terrainLight = 0.82 + light * 0.20 + (paint - 0.5) * 0.23;
            gl_FragColor.rgb = gl_FragColor.rgb * (1.0 - dot(bakedWeights, vec3(1.0))) + bakedGround * terrainLight;
            gl_FragColor.rgb = mix(gl_FragColor.rgb, dirt, exposed);
            float steepness = 1.0 - surfaceNormal.y;
            float rockExposure = smoothstep(0.10, 0.37, steepness + vGroundHeight * 0.024 + (paint - 0.5) * 0.20 + fissures * 0.14);
            float exposedRock = ridge + mountain * rockExposure;
            vec2 rockUv = vec2(dot(surface, vec2(1.16, 0.81)) + paint * 0.78,
              vGroundHeight * 0.98 + dot(surface, vec2(-0.15, 0.22))) / 11.0;
            float fractured = texture2D(terrainDetail, rockUv).b - 0.5;
            float ledgePhase = vGroundHeight * 1.06 + dot(surface, vec2(-0.22, 0.31)) + paint * 1.35 + fractured * 0.67;
            float strata = 1.0 - smoothstep(0.045, 0.20 + min(0.20, fwidth(ledgePhase)), abs(fract(ledgePhase) - 0.5));
            float paintDetail = 1.0 - smoothstep(0.12, 0.41, length(fwidth(surface)));
            vec3 foothill = mix(vec3(0.21, 0.32, 0.15), vec3(0.42, 0.50, 0.26), paint);
            foothill *= (0.70 + light * 0.39) * (1.0 + blades * 0.73 + grit * 0.26);
            vec3 rockFace = mix(vec3(0.14, 0.17, 0.16), vec3(0.65, 0.53, 0.39), light);
            rockFace *= 0.91 + paint * 0.18 + fractured * 0.86 + grit * 0.32;
            rockFace += vec3(0.062, 0.052, 0.036) * strata * paintDetail * smoothstep(0.28, 0.74, paint);
            vec2 mountainUv = (mat2(0.83, 0.56, -0.56, 0.83) * surface + vec2(0.23, 0.9) * vGroundHeight) / 12.5;
            vec4 weatheredRock = texture2D(mountainSurface, mountainUv);
            weatheredRock.rgb *= mix(vec3(0.37, 0.45, 0.54), vec3(1.05, 1.01, 0.98), light);
            rockFace = mix(rockFace, weatheredRock.rgb, weatheredRock.a);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, foothill, mountain * (1.0 - rockExposure) * 0.85);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, rockFace, exposedRock * 0.88);
            float crystal = smoothstep(0.10, 0.85, biomeWeight(${terrainBiomes.indexOf('crystal')}.0));
            vec4 veinedSlate = texture2D(crystalSurface, tiling * 0.88);
            gl_FragColor.rgb = mix(gl_FragColor.rgb, veinedSlate.rgb * (0.75 + light * 0.30), crystal * veinedSlate.a * 0.90);
            float seams = pow(0.5 + 0.5 * sin(dot(surface, vec2(2.0, -2.7)) + paint * 2.0), 10.0);
            gl_FragColor.rgb += vec3(0.052, 0.04, 0.11) * seams * crystal * paintDetail * (1.0 - veinedSlate.a);
            ${fogTint}
            float preferred = smoothstep(0.40, 0.90, biomeWeight(preferredBiome));
            if (preferred > 0.0) {
              float explored = 1.0 - smoothstep(0.27, 0.46, texture2D(sightFog, vSightUv).r);
              gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.32, 0.91, 0.70), explored * preferred * 0.58);
            }
            vec4 claim = claimAt(vSightUv);
            if (claim.a > 0.0) {
              vec2 width = vec2(0.32) / vec2(${MAP_WIDTH}.0, ${MAP_DEPTH}.0);
              bool edge = any(notEqual(claim, claimAt(vSightUv + vec2(width.x, 0.0))))
                || any(notEqual(claim, claimAt(vSightUv - vec2(width.x, 0.0))))
                || any(notEqual(claim, claimAt(vSightUv + vec2(0.0, width.y))))
                || any(notEqual(claim, claimAt(vSightUv - vec2(0.0, width.y))));
              if (edge) {
                float reveal = claim.a > 0.9 ? 1.0 : 1.0 - smoothstep(0.34, ${TERRITORY_FOG_LIMIT / 255}, texture2D(sightFog, vSightUv).r);
                float tint = 0.0;
                if (claim.a > 0.9 && attackBorder.z > 0.0) {
                  tint = attackBorder.z * (1.0 - smoothstep(${ATTACK_BORDER_INNER}.0, ${ATTACK_BORDER_RADIUS}.0, distance(surface, attackBorder.xy)));
                }
                vec3 borderColor = mix(claim.rgb, vec3(${ATTACK_BORDER_COLOR.map((channel) => (channel / 255).toFixed(4)).join(', ')}), tint);
                gl_FragColor.rgb = mix(gl_FragColor.rgb, borderColor, reveal * (0.85 + tint * 0.15));
              }
            }
            #include <dithering_fragment>
          `);
      } else {
        shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', `
          ${fogTint}
          #include <dithering_fragment>
        `);
      }
    };
    if (terrainGuide) material.customProgramCacheKey = () => 'baked-terrain-with-guides';
    return material;
  }

  makeLandingApron() {
    const { home } = this.world;
    const layers = new Map();
    const triangle = (color, a, b, c) => {
      if (!layers.has(color)) layers.set(color, []);
      const vertices = layers.get(color);
      for (const [dx, dz] of [a, c, b]) {
        const x = home.x + dx;
        const z = home.z + dz;
        vertices.push(x, this.world.elevation(x, z) + 0.09, z);
      }
    };
    const quad = (color, a, b, c, d) => { triangle(color, a, b, c); triangle(color, a, c, d); };
    const polar = (radius, angle) => [radius * Math.cos(angle), radius * Math.sin(angle)];
    for (let index = 0; index < 40; index++) {
      const angle = index / 40 * Math.PI * 2;
      const next = (index + 1) / 40 * Math.PI * 2;
      triangle(index % 5 === 0 ? '#566066' : '#3d474e', [0, 0], polar(3.28, angle), polar(3.28, next));
      quad(index % 5 < 2 ? '#ccaa65' : '#4b666a', polar(3.28, angle), polar(3.48, angle), polar(3.48, next), polar(3.28, next));
    }
    for (const z of [3.75, 4.4, 5.05, 5.7, 6.35]) {
      for (const x of [-0.63, 0.51]) {
        quad('#a9b9ad', [x, z], [x + 0.12, z], [x + 0.12, z + 0.31], [x, z + 0.31]);
      }
    }
    for (const [color, vertices] of layers) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, material(color));
      mesh.userData.ownedGeometry = true;
      this.static.add(mesh);
    }
    for (const side of [-1, 1]) {
      for (const z of [3.9, 5.1, 6.3]) {
        const x = home.x + side * 0.83;
        primitive(this.static, 'box', '#8ce7ec', x, this.world.elevation(x, home.z + z) + 0.16, home.z + z, 0.17, 0.16, 0.17, true);
      }
    }
  }

  makeTerrain() {
    const { world } = this;
    const ground = new THREE.Group();
    const surface = this.fogMaterial({ vertexColors: true, roughness: 1 }, true);
    const weights = new Float64Array(terrainBiomes.length);
    const color = new Float64Array(3);
    const normal = new THREE.Vector3();
    for (let left = MAP_MIN_X; left < MAP_MAX_X; left += SCENERY_CHUNK_SIZE) {
      for (let top = MAP_MIN_Z; top < MAP_MAX_Z; top += SCENERY_CHUNK_SIZE) {
        const width = Math.min(SCENERY_CHUNK_SIZE, MAP_MAX_X - left);
        const depth = Math.min(SCENERY_CHUNK_SIZE, MAP_MAX_Z - top);
        const columns = Math.ceil(width / TERRAIN_CELL_SIZE);
        const geometry = new THREE.PlaneGeometry(width, depth, columns, Math.ceil(depth / TERRAIN_CELL_SIZE));
        geometry.rotateX(-Math.PI / 2);
        const centerX = left + width / 2;
        const centerZ = top + depth / 2;
        const positions = geometry.getAttribute('position');
        const colors = new Float32Array(positions.count * 3);
        const weightsA = new Float32Array(positions.count * 3);
        const weightsB = new Float32Array(positions.count * 3);
        for (let index = 0; index < positions.count; index++) {
          const x = centerX + positions.getX(index);
          const z = centerZ + positions.getZ(index);
          positions.setY(index, world.elevation(x, z));
          world.biomeWeights(x, z, weights);
          const ridge = world.ridgeWeight(x, z);
          blendTerrainColor(weights, ridge, terrainPaint(x, z, world.seed), color);
          for (let channel = 0; channel < 3; channel++) {
            const offset = index * 3 + channel;
            colors[offset] = color[channel];
            weightsA[offset] = weights[channel] * (1 - ridge);
            weightsB[offset] = weights[channel + 3] * (1 - ridge);
          }
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.setAttribute('biomeWeightsA', new THREE.BufferAttribute(weightsA, 3));
        geometry.setAttribute('biomeWeightsB', new THREE.BufferAttribute(weightsB, 3));
        geometry.computeVertexNormals();
        const normals = geometry.getAttribute('normal');
        const stride = columns + 1;
        for (let index = 0; index < positions.count; index++) {
          const column = index % stride;
          if (column !== 0 && column !== columns && index >= stride && index < positions.count - stride) continue;
          // Sample both sides so the lighting agrees where terrain chunks meet.
          const x = centerX + positions.getX(index);
          const z = centerZ + positions.getZ(index);
          const dx = world.elevation(x - 0.5, z) - world.elevation(x + 0.5, z);
          const dz = world.elevation(x, z - 0.5) - world.elevation(x, z + 0.5);
          normal.set(dx, 1, dz).normalize();
          normals.setXYZ(index, normal.x, normal.y, normal.z);
        }
        const tile = new THREE.Mesh(geometry, surface);
        tile.position.set(centerX, 0, centerZ);
        tile.userData.ownedGeometry = true;
        tile.userData.ownedMaterial = !ground.children.length;
        ground.add(tile);
      }
    }
    this.terrain = ground;
    this.static.add(ground);
    ground.updateMatrixWorld(true);
  }

  makeLandscape() {
    const { world } = this;
    const random = randomFrom(world.seed + 190);
    const trees = [];
    const rocks = [];
    for (const node of world.gatherables) {
      if (node.surface <= 0) continue;
      const item = { ...node, node, y: world.elevation(node.x, node.z) };
      (node.kind === 'tree' ? trees : rocks).push(item);
    }
    const grass = [];
    const weights = new Float64Array(terrainBiomes.length);
    const samples = Math.round(MAP_WIDTH * MAP_DEPTH * 0.39);
    for (let i = 0; i < samples; i++) {
      const x = MAP_MIN_X + 0.5 + random() * (MAP_WIDTH - 1);
      const z = MAP_MIN_Z + 0.5 + random() * (MAP_DEPTH - 1);
      const point = { x, z };
      if (world.landingSites.some((home) => distance(point, home) < 3.3)
        || world.deposits.some((deposit) => distance(point, deposit) < 1.28)
        || world.navigation.intersects(point, point, 0, (shape) => shape.kind === 'ridge')) continue;
      world.biomeWeights(x, z, weights);
      let roll = random();
      const index = weights.findIndex((weight) => (roll -= weight) < 0);
      const type = terrainBiomes[index] ?? world.sample(x, z);
      const item = { x, z, y: world.elevation(x, z), size: random(), angle: random() * Math.PI, tone: random(), type };
      const cover = type === 'plains' ? 0.44 : type === 'forest' ? 0.12 : type === 'desert' ? 0.15 : 0;
      if (cover && random() < cover * terrainPaint(x, z, world.seed)) grass.push(item);
    }
    const batch = (geometry, items, transform, ownsGeometry = true) => {
      if (!items.length) {
        if (ownsGeometry) geometry.dispose();
        return;
      }
      const chunks = new Map();
      for (const item of items) {
        const column = Math.floor((item.x - MAP_MIN_X) / SCENERY_CHUNK_SIZE);
        const row = Math.floor((item.z - MAP_MIN_Z) / SCENERY_CHUNK_SIZE);
        const key = `${column},${row}`;
        if (!chunks.has(key)) chunks.set(key, []);
        chunks.get(key).push(item);
      }
      const surface = this.fogMaterial({ roughness: 0.95, flatShading: true, vertexColors: geometry.hasAttribute('color') });
      const marker = new THREE.Object3D();
      const color = new THREE.Color();
      let first = true;
      for (const chunk of chunks.values()) {
        const meshes = new THREE.InstancedMesh(geometry, surface, chunk.length);
        chunk.forEach((item, index) => {
          transform(item, marker, color);
          marker.updateMatrix();
          meshes.setMatrixAt(index, marker.matrix);
          meshes.setColorAt(index, color);
          if (item.node) {
            if (!this.gatherableInstances.has(item.node)) this.gatherableInstances.set(item.node, []);
            this.gatherableInstances.get(item.node).push({ meshes, index });
          }
        });
        meshes.userData.ownedGeometry = first && ownsGeometry;
        meshes.userData.ownedMaterial = first;
        first = false;
        this.static.add(meshes);
      }
    };

    if (this.pineModels.length) {
      const variants = this.pineModels.map(() => []);
      for (const tree of trees) variants[Math.floor(tree.tone * variants.length)].push(tree);
      this.pineModels.forEach((geometry, index) => {
        batch(geometry, variants[index], (item, marker, color) => {
          const width = 0.65 + item.size * 0.52;
          const height = 0.62 + item.size * 0.65;
          marker.position.set(item.x, item.y - 0.015, item.z);
          marker.rotation.y = item.angle;
          marker.scale.set(width, height, width);
          color.setScalar(0.84 + 0.22 * item.tone);
        }, false);
      });
    } else {
      batch(new THREE.CylinderGeometry(0.075, 0.13, 0.65, 10), trees, (item, marker, color) => {
        marker.position.set(item.x, item.y + 0.22, item.z);
        marker.scale.setScalar(0.75 + item.size * 0.60);
        color.set('#574f37');
      });
      for (let layer = 0; layer < 2; layer++) {
        batch(new THREE.ConeGeometry(0.54, 1.25, 10), trees, (item, marker, color) => {
          const size = 0.61 + item.size * 1.18;
          marker.position.set(item.x, item.y + size * (0.52 + layer * 0.38), item.z);
          marker.scale.set(size * (1 - layer * 0.27), size * 0.83, size * (1 - layer * 0.27));
          marker.rotation.y = item.angle + layer * 0.4;
          color.set(item.tone > 0.65 ? '#647d42' : '#416344').multiplyScalar(0.81 + item.tone * 0.28 + layer * 0.13);
        });
      }
    }
    batch(new THREE.DodecahedronGeometry(0.62, 0), rocks, (item, marker, color) => {
      const size = 0.52 + item.size ** 2 * 0.79;
      marker.position.set(item.x, item.y + size * 0.24, item.z);
      marker.scale.set(size, size * (0.51 + item.tone * 0.74), size * 0.72);
      marker.rotation.set(item.tone, item.angle, item.size);
      color.set('#8d7760').multiplyScalar(0.80 + item.tone * 0.43);
    });
    batch(new THREE.CylinderGeometry(0.04, 0.14, 0.40, 5), rocks, (item, marker, color) => {
      marker.position.set(item.x + 0.14, item.y + 0.35 + item.size * 0.25, item.z - 0.15);
      marker.scale.setScalar(0.74 + item.size * 0.50);
      marker.rotation.set(0.40, item.angle, -0.45);
      color.set('#d1a465');
    });
    batch(grassTuftGeometry(), grass, (item, marker, color) => {
      marker.position.set(item.x, item.y - 0.02, item.z);
      marker.scale.set(0.85 + item.size, 0.70 + item.size, 0.85 + item.size);
      marker.rotation.set(0, item.angle, 0);
      color.set(item.type === 'desert' ? '#ad9a62' : item.tone < 0.5 ? '#91a35b' : '#a6ae63');
    });
  }

  updateHarvestables() {
    const harvested = this.world.harvestedGatherables;
    for (; this.harvestedCount < harvested.length; this.harvestedCount++) {
      const node = harvested[this.harvestedCount];
      for (const { meshes, index } of this.gatherableInstances.get(node) ?? []) {
        meshes.setMatrixAt(index, this.hiddenInstance);
        meshes.instanceMatrix.needsUpdate = true;
      }
      this.gatherableInstances.delete(node);
    }
  }

  makeDeposit(deposit) {
    const group = new THREE.Group();
    const random = randomFrom(this.world.seed + Math.round(deposit.x * 150));
    const styles = {
      metal: ['#c7a26c', '#605853', 'sphere', 7],
      biomass: ['#739a52', '#456845', 'cone', 6],
      crystal: ['#c3a8f6', '#766cba', 'shard', 8],
      vent: ['#d88056', '#77534a', 'sphere', 8],
    };
    const [color, dark, shape, count] = styles[deposit.type];
    const marker = octagon(color, 1.75, 0.14);
    marker.position.y = 0.08;
    marker.userData.ownedGeometry = true;
    marker.userData.ownedMaterial = true;
    group.add(marker);
    group.position.set(deposit.x, this.world.elevation(deposit.x, deposit.z), deposit.z);
    const grove = deposit.type === 'biomass' && this.pineModels.length > 0;
    if (grove) {
      const heading = random() * Math.PI * 2;
      this.pineModels.forEach((geometry, index) => {
        const angle = heading + index * Math.PI * 2 / this.pineModels.length;
        const x = Math.cos(angle) * 0.58;
        const z = Math.sin(angle) * 0.58;
        const tree = new THREE.Mesh(geometry, this.groveMaterial);
        tree.position.set(x, this.world.elevation(deposit.x + x, deposit.z + z) - group.position.y, z);
        tree.scale.setScalar(0.48 + random() * 0.26);
        tree.rotation.y = angle;
        group.add(tree);
      });
    } else {
      for (let i = 0; i < count; i++) {
        const angle = i * Math.PI * 2 / count;
        const size = 0.58 + random() * 0.61;
        const model = primitive(group, shape, i % 3 === 2 ? dark : color, Math.cos(angle) * 0.84, size * (shape === 'shard' ? 0.74 : 0.35), Math.sin(angle) * 0.78,
          size, size * (shape === 'shard' ? 1.94 : 1.28), size * 0.85);
        model.rotation.set(random() * 0.35, angle, 0.22 - random() * 0.44);
      }
    }
    if (deposit.type === 'metal') {
      const vein = primitive(group, 'sphere', '#a48b6b', 0.05, 0.31, -0.07, 0.99, 0.59, 0.81);
      vein.rotation.set(0.15, 0.33, 0.10);
      primitive(group, 'shard', '#deb682', -0.07, 0.42, 0.12, 0.16, 0.47, 0.20).rotation.z = -0.63;
    } else if (deposit.type === 'biomass' && !grove) {
      primitive(group, 'sphere', '#88a161', 0.02, 0.54, -0.12, 0.72, 0.75, 0.76);
      primitive(group, 'cone', '#577150', -0.29, 0.66, -0.24, 0.46, 1.16, 0.47);
    } else if (deposit.type === 'vent') {
      primitive(group, 'drum', '#562d27', 0, 0.22, 0, 0.73, 0.31, 0.71);
      primitive(group, 'drum', '#ffac6d', 0, 0.39, 0, 0.45, 0.042, 0.45, true);
      this.ventSites.push({ x: deposit.x, z: deposit.z, y: group.position.y, phase: random() });
    }
    group.userData.deposit = deposit;
    this.static.add(group);
    this.makeLabel(deposit, deposit.label, deposit.type === 'vent' ? 'Energy site' : deposit.type, deposit.type, 1.63, true);
  }

  makeLabel(point, title, category, style, height, visibleInFog = false) {
    const element = document.createElement('div');
    element.hidden = true;
    element.className = `map-label map-label--${style}`;
    const marker = document.createElement('i');
    const text = document.createElement('span');
    text.textContent = title;
    element.setAttribute('aria-label', `${title}, ${category}`);
    element.append(marker, text);
    this.overlay.append(element);
    const label = { point, element, text, height, style, visibleInFog };
    this.labels.push(label);
    return label;
  }

  setPointerRay(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set((clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
  }

  pointAt(clientX, clientY) {
    this.setPointerRay(clientX, clientY);
    const hit = this.ray.intersectObject(this.terrain, true)[0];
    return hit ? { x: hit.point.x, z: hit.point.z } : null;
  }

  screenAt(point, height = 0.12) {
    const vector = new THREE.Vector3(point.x, this.world.elevation(point.x, point.z) + height, point.z).project(this.camera);
    return { x: (vector.x + 1) * this.canvas.clientWidth / 2, y: (1 - vector.y) * this.canvas.clientHeight / 2, depth: vector.z };
  }

  structureAtLabel(clientX, clientY, candidates) {
    for (let index = candidates.length - 1; index >= 0; index--) {
      const building = candidates[index];
      const label = this.entityModels.get(this.modelKey(building))?.label?.element;
      if (!label || label.hidden) continue;
      const { left, right, top, bottom } = label.getBoundingClientRect();
      if (clientX >= left && clientX <= right && clientY >= top && clientY <= bottom) return building;
    }
    return null;
  }

  entityAtModel(clientX, clientY, candidates) {
    const visuals = new Map();
    for (const entity of candidates) {
      const model = this.entityModels.get(this.modelKey(entity));
      if (model?.root.visible) visuals.set(model.visual, entity);
    }
    if (!visuals.size) return null;
    this.setPointerRay(clientX, clientY);
    const hit = this.ray.intersectObjects([...visuals.keys()], true)[0];
    if (!hit) return null;
    for (let object = hit.object; object; object = object.parent) {
      if (visuals.has(object)) return visuals.get(object);
    }
    return null;
  }

  constructionAtBar(clientX, clientY, candidates) {
    let closest = null;
    let closestDistance = Infinity;
    for (const building of candidates) {
      if (building.progress >= 1) continue;
      const bar = this.blueprintLabels.get(building) ?? this.entityModels.get(this.modelKey(building))?.bar;
      if (!bar || bar.hidden) continue;
      const { left, right, top, bottom } = bar.getBoundingClientRect();
      if (clientX < left || clientX > right || clientY < top - 3 || clientY > bottom + 3) continue;
      const distance = Math.hypot(clientX - (left + right) / 2, clientY - (top + bottom) / 2);
      if (distance < closestDistance) {
        closest = building;
        closestDistance = distance;
      }
    }
    return closest;
  }

  modelKey(entity) {
    return entity.factionId && entity.factionId !== this.world.localFaction ? `${entity.factionId}:${entity.id}` : entity.id;
  }

  showPlacement(type, site) {
    const range = BUILDINGS[type]?.combat?.range;
    this.defensePreview = range && site && !site.error ? { x: site.x, z: site.z, range } : null;
    if (this.ghost?.userData.type !== type) {
      if (this.ghost) this.scene.remove(this.ghost);
      this.ghost = type ? buildingModel(type) : null;
      if (this.ghost) {
        this.ghost.userData.type = type;
        this.ghost.traverse((mesh) => {
          if (!mesh.isMesh) return;
          mesh.material = this.ghostMaterial;
        });
        this.scene.add(this.ghost);
      }
    }
    if (!this.ghost) return;
    this.ghost.visible = Boolean(site);
    if (site) {
      this.ghost.position.set(site.x, this.world.elevation(site.x, site.z) + 0.12, site.z);
      if (site.wall) this.poseWall(this.ghost, site.wall);
      this.ghostMaterial.color.set(site.error ? '#ff887e' : '#a6f4d6');
    }
  }

  showConstructionLine(sites) {
    const ready = [];
    const blocked = [];
    for (const site of sites) {
      const vertices = site.error ? blocked : ready;
      if (site.wall) {
        this.addRoutePoint(vertices, site.wall.a);
        this.addRoutePoint(vertices, site.wall.b);
      } else this.addWaypointMarker(vertices, site, 1.05, 8);
    }
    for (const [line, vertices] of [[this.constructionPreview, ready], [this.blockedConstructionPreview, blocked]]) {
      line.visible = Boolean(vertices.length);
      if (line.visible) this.updateRouteLine(line, vertices);
    }
  }

  poseWall(visual, { a, b }) {
    const span = distance(a, b);
    visual.scale.z = span / WALL_LENGTH;
    visual.rotation.set(Math.atan2(this.world.elevation(a.x, a.z) - this.world.elevation(b.x, b.z), span),
      Math.atan2(b.x - a.x, b.z - a.z), 0, 'YXZ');
  }

  showSitingGuide(biome, deposits, sites = []) {
    this.preferredBiome.value = terrainBiomes.indexOf(biome);
    const preferred = new Set(deposits.map((deposit) => deposit.id));
    for (const [name, line, points, radius] of [
      ['available', this.availableDepositMarkers, sites.filter((site) => !preferred.has(site.id)), 2.2],
      ['preferred', this.recommendedDepositMarkers, deposits, 2.5],
    ]) {
      const ids = points.map((deposit) => deposit.id);
      const key = ids.join(',');
      if (key === line.userData.siteKey) continue;
      line.userData.siteKey = key;
      this.depositGuideIds[name] = new Set(ids);
      line.visible = Boolean(points.length);
      if (!line.visible) continue;
      const vertices = [];
      for (const deposit of points) {
        this.addWaypointMarker(vertices, deposit, radius, 24);
        this.addWaypointMarker(vertices, deposit, radius + 0.29, 4);
      }
      this.updateRouteLine(line, vertices);
    }
  }

  drawUnitRemains(state, sight) {
    if (!this.world.unitRemains.length && !this.remainsModels.size) return;
    const active = new Set(this.world.unitRemains);
    for (const [record, model] of this.remainsModels) {
      if (active.has(record)) continue;
      this.remains.remove(model);
      this.remainsModels.delete(record);
    }
    for (const record of active) {
      const visible = record.factionId === state.country || inSight(record, sight);
      let model = this.remainsModels.get(record);
      if (visible && !model) {
        model = fallenUnitModel(record.type);
        const radius = UNITS[record.type] ? Math.max(0.47, unitHitRadius(record.type) * 1.8) : 0.98;
        const shadow = contactShadow(radius);
        shadow.position.y = 0.04;
        model.add(shadow);
        model.position.set(record.x, this.world.elevation(record.x, record.z), record.z);
        model.rotation.y = record.heading;
        this.remains.add(model);
        this.remainsModels.set(record, model);
      }
      if (model) model.visible = visible;
    }
  }

  drawBlueprints(state, selection) {
    const queued = new Set(state.buildings.filter(isBlueprint));
    for (const [site, label] of this.blueprintLabels) {
      if (queued.has(site)) continue;
      label.remove();
      this.blueprintLabels.delete(site);
    }
    const vertices = [];
    for (const site of queued) {
      const { x, y } = this.screenAt(site, 0.36);
      const visible = x >= 0 && x <= this.canvas.clientWidth && y >= 0 && y <= this.canvas.clientHeight;
      let label = this.blueprintLabels.get(site);
      if (label) label.hidden = !visible;
      if (!visible) continue;
      const { radius } = buildingFootprint(site);
      if (site.wall) {
        const { a, b } = site.wall;
        const span = distance(a, b);
        const dx = (b.z - a.z) / span * radius;
        const dz = (a.x - b.x) / span * radius;
        const corners = [{ x: a.x + dx, z: a.z + dz }, { x: b.x + dx, z: b.z + dz },
          { x: b.x - dx, z: b.z - dz }, { x: a.x - dx, z: a.z - dz }];
        for (let index = 0; index < corners.length; index++) {
          this.addRoutePoint(vertices, corners[index]);
          this.addRoutePoint(vertices, corners[(index + 1) % corners.length]);
        }
      } else this.addWaypointMarker(vertices, site, radius, 16);
      if (!label) {
        label = document.createElement('div');
        label.className = 'construction-blueprint';
        this.overlay.append(label);
        this.blueprintLabels.set(site, label);
      }
      const selected = selection.has(site.id);
      label.classList.toggle('selected', selected);
      const status = site.blockedFootprint ? 'Site blocked'
        : site.materialShortage ? `Waiting for ${RESOURCES[site.materialShortage].name.toLowerCase()}` : 'Queued';
      if (label.textContent !== status) label.textContent = status;
      label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    }
    this.blueprintOutlines.visible = Boolean(vertices.length);
    if (vertices.length) this.updateRouteLine(this.blueprintOutlines, vertices);
  }

  draw(state, selection, target, sight, tutorialTarget, alert) {
    const { world } = this;
    this.updateTerritory();
    if (alert?.border) this.attackBorder.value.set(alert.border.x - MAP_MIN_X, alert.border.z - MAP_MIN_Z, alert.strength);
    else this.attackBorder.value.z = 0;
    this.updateHarvestables();
    this.updateDust();
    this.drawUnitRemains(state, sight);
    this.drawBlueprints(state, selection);
    const alive = new Set();
    const shots = [];
    const occupiedDeposits = new Set([...state.factions.values()].flatMap((faction) => faction.buildings
      .filter((building) => building.deposit && !isBlueprint(building) && (faction === state || inSight(building, sight))).map((building) => building.deposit.id)));
    const mines = highlightedMines(state, selection);
    const highlightedMineIds = new Set(mines.map((mine) => mine.id));
    const place = (entity, modelKind, neighbor = false, ringColor = '#9bedd9') => {
      const modelId = this.modelKey(entity);
      alive.add(modelId);
      let model = this.entityModels.get(modelId);
      if ((neighbor || modelKind === 'enemy') && !inSight(entity, sight)) {
        if (model) {
          model.root.visible = false;
          if (model.bar) model.bar.hidden = true;
          if (model.healthBar) model.healthBar.hidden = true;
          model.healthBarTop = null;
        }
        return;
      }
      if (!model) {
        const root = new THREE.Group();
        const visual = modelKind === 'building' ? buildingModel(entity.type) : unitModel(entity.type || entity.kind);
        const foot = contactShadow(entity.type === 'command' ? 3.1 : entity.wall ? 0.69
          : modelKind === 'building' ? 1.58 : modelKind === 'enemy' ? 1.28 : 0.69);
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.68, 0.74, 24), new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.9, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.085;
        foot.position.y = 0.052;
        root.add(foot, ring, visual);
        this.entities.add(root);
        if (entity.wall) this.poseWall(visual, entity.wall);
        const workEffect = entity.type === 'rover' ? roverWorkEffect() : null;
        if (workEffect) root.add(workEffect.group);
        const roof = new THREE.Box3().setFromObject(visual).max.y;
        root.position.set(entity.x, world.elevation(entity.x, entity.z) + 0.018, entity.z);
        model = { root, visual, ring, workEffect, roof };
        if (modelKind === 'building' && !neighbor && entity.type !== 'command') {
          model.label = this.makeLabel(entity, BUILDINGS[entity.type].name, 'Your structure', 'structure', 0, true);
          model.label.element.dataset.type = entity.type;
        }
        this.entityModels.set(modelId, model);
      }
      const gear = model.visual.userData.gear;
      if (gear) {
        const moved = Math.hypot(entity.x - model.root.position.x, entity.z - model.root.position.z);
        if (moved < 2) this.rollRunningGear(model, gear, moved, entity);
      }
      if (model.root.position.x !== entity.x || model.root.position.z !== entity.z) {
        model.root.position.set(entity.x, world.elevation(entity.x, entity.z) + 0.018, entity.z);
      }
      model.ring.visible = neighbor || selection.has(entity.id);
      if (neighbor && model.ringColor !== ringColor) {
        model.ring.material.color.set(ringColor);
        model.ringColor = ringColor;
      }
      model.ring.scale.setScalar(entity.type === 'command' ? 3.15 : modelKind === 'building' ? 1.65 : 1);
      if (!entity.wall) model.visual.rotation.y = entity.heading || 0;
      if (model.visual.userData.tail) model.visual.userData.tail.rotation.y = Math.sin(state.time * 3.1 + entity.phase) * 0.23;
      const turret = model.visual.userData.turret;
      if (turret) {
        const heading = model.visual.rotation.y;
        turret.rotation.y = state.time - entity.fired < 2.1 ? (entity.aim ?? heading) - heading : 0;
      }
      if (modelKind === 'building') {
        const commandScale = entity.type === 'command' ? 1 + ((entity.tier ?? 1) - 1) * 0.18 : 1;
        model.visual.scale.y = (0.30 + entity.progress * 0.7) * commandScale;
        if (entity.type === 'uplink') this.animateUplink(model.visual, entity, state.time);
        if (model.label) this.updateStructureLabel(model, entity, selection.has(entity.id), highlightedMineIds.has(entity.id));
      }
      model.root.visible = true;
      if (model.workEffect) animateRoverWork(model.workEffect, entity.work, state.time + entity.id * 0.09, entity.heading);
      if (modelKind === 'building') this.drawBuildBar(model, entity, neighbor);
      const maximum = modelKind === 'building' ? maxBuildingHealth(entity) : UNITS[entity.type]?.health ?? entity.maxHealth;
      this.drawHealthBar(model, entity, maximum, !neighbor && selection.has(modelId));
      if (entity.shotTarget && state.time - entity.fired < 0.14 && !UNITS[entity.type]?.combat?.shell) {
        const end = entity.shotTarget;
        shots.push(entity.x, model.root.position.y + (modelKind === 'building' ? 1.43 : 0.75), entity.z,
          end.x, world.elevation(end.x, end.z) + 0.48, end.z);
      }
    };
    for (const building of state.buildings) if (!isBlueprint(building)) place(building, 'building');
    for (const unit of state.units) place(unit, 'unit');
    for (const enemy of state.hostiles) if (enemy.health > 0) place(enemy, 'enemy');
    for (const faction of state.factions.values()) {
      if (faction === state || !state.sightings.has(faction.country)) continue;
      if (!this.markedFactions.has(faction.country)) {
        this.makeLabel(faction.home, faction.name, 'Settlement', 'neighbor', 2.88);
        this.markedFactions.add(faction.country);
      }
      const relation = state.diplomacy.between(state.country, faction.country).state;
      const color = relation === STANCE.WAR ? '#ff7867' : relation === STANCE.CEASEFIRE ? '#9edcff' : '#ffbb74';
      for (const building of faction.buildings) if (!isBlueprint(building)) place(building, 'building', true, color);
      for (const unit of faction.units) place(unit, 'unit', true, color);
    }
    for (const [id, model] of this.entityModels) {
      if (alive.has(id)) continue;
      disposeRoverWork(model.workEffect);
      model.bar?.remove();
      model.healthBar?.remove();
      if (model.label) {
        model.label.element.remove();
        this.labels.splice(this.labels.indexOf(model.label), 1);
      }
      this.entities.remove(model.root);
      this.entityModels.delete(id);
    }
    for (const item of this.static.children) {
      const site = item.userData.site;
      const deposit = item.userData.deposit;
      if (site) item.visible = site.discovered && (site.relay || inSight(site, sight));
      if (deposit) item.visible = !occupiedDeposits.has(deposit.id);
    }
    for (const { point, element, text, height, style, visibleInFog } of this.labels) {
      if ((!this.buildingNamesVisible && ['structure', 'home', 'neighbor'].includes(style)) || occupiedDeposits.has(point.id)) {
        element.hidden = true;
        continue;
      }
      const position = this.screenAt(point, height);
      const structure = style === 'home' ? state.buildings[0] : style === 'structure' ? point : null;
      if (structure) {
        const healthTop = this.entityModels.get(this.modelKey(structure))?.healthBarTop;
        if (healthTop != null) position.y = Math.min(position.y, healthTop - 3);
      }
      const onScreen = position.x > 32 && position.x < this.canvas.clientWidth - 32 && position.y > 38 && position.y < this.canvas.clientHeight - 25;
      const known = visibleInFog || (point.relay && point.discovered)
        || ((style === 'neighbor' || point.discovered) && inSight(point, sight));
      element.hidden = !onScreen || !known;
      if (!element.hidden) element.style.transform = `translate(${position.x}px, ${position.y}px) translate(-50%, -100%)`;
      if ('amount' in point) {
        element.classList.toggle('depleted', point.amount <= 0);
        element.classList.toggle('map-label--available-site', this.depositGuideIds.available.has(point.id));
        element.classList.toggle('map-label--preferred-site', this.depositGuideIds.preferred.has(point.id));
      }
      if (style === 'home') {
        const label = `Command Center · Tier ${state.buildings[0].tier ?? 1}`;
        if (text.textContent !== label) text.textContent = label;
      } else if (point.relay && point.owner === state.country) {
        element.classList.add('map-label--captured');
        const label = `${point.name} · Captured`;
        if (text.textContent !== label) text.textContent = label;
      }
    }
    this.shots.visible = Boolean(shots.length);
    if (this.shots.visible) this.updateRouteLine(this.shots, shots);
    this.drawShells(state, sight);
    this.drawOrders(state, selection, target);
    this.drawSpatialGuides(state, selection, tutorialTarget, mines);
    this.drawVapor(state.time);
    this.renderer.render(this.scene, this.camera);
  }

  drawShells(state, sight) {
    const heads = [];
    const trails = [];
    for (const shell of this.world.shells) {
      if (shell.factionId !== state.country && !inSight(shell.from, sight)) continue;
      const { from, to, type, duration, aim } = shell;
      const scale = UNITS[type].scale ?? 1;
      const muzzle = Math.min(distance(from, to) * 0.6, (type === 'siege' ? 1.08 : 0.72) * scale);
      const startX = from.x + Math.sin(aim) * muzzle;
      const startZ = from.z + Math.cos(aim) * muzzle;
      const startY = this.world.elevation(from.x, from.z) + 0.79 * scale;
      const endY = this.world.elevation(to.x, to.z) + 0.48;
      const fraction = Math.min(1, Math.max(0, (state.time - shell.fired) / duration));
      const append = (vertices, t) => vertices.push(
        THREE.MathUtils.lerp(startX, to.x, t),
        THREE.MathUtils.lerp(startY, endY, t) + Math.sin(Math.PI * t) * (type === 'siege' ? 0.9 : 0.35),
        THREE.MathUtils.lerp(startZ, to.z, t),
      );
      append(heads, fraction);
      if (fraction < 1) {
        append(trails, Math.max(0, fraction - 0.32));
        append(trails, fraction);
      }
    }
    this.shellHeads.visible = Boolean(heads.length);
    this.shellTrails.visible = Boolean(trails.length);
    if (heads.length) this.updateRouteLine(this.shellHeads, heads);
    if (trails.length) this.updateRouteLine(this.shellTrails, trails);
  }

  updateStructureLabel(model, building, selected, highlighted) {
    const { element, text } = model.label;
    const status = building.progress < 1 ? 'building' : building.health <= 0 ? 'disabled'
      : building.deposit?.amount <= 0 ? 'depleted' : 'active';
    if (element.dataset.state !== status) {
      element.dataset.state = status;
      const suffix = status === 'disabled' ? ' · Disabled' : status === 'depleted' ? ' · Depleted' : '';
      text.textContent = `${BUILDINGS[building.type].name}${suffix}`;
    }
    element.classList.toggle('map-label--selected', selected);
    element.classList.toggle('map-label--highlighted-mine', highlighted);
    model.label.height = model.roof * model.visual.scale.y + (building.progress < 1 || building.launch ? 0.94 : 0.39);
  }

  // Rolls wheels by the distance the unit actually travelled and kicks up dust behind it.
  rollRunningGear(model, gear, moved, entity) {
    if (!moved) return;
    const scale = model.visual.scale.x || 1;
    model.travel = (model.travel ?? 0) + moved / scale;
    for (const wheel of gear.wheels) wheel.rotation.x = model.travel / wheel.userData.radius;
    model.dustDistance = (model.dustDistance ?? 0) + moved;
    if (model.dustDistance < 0.22) return;
    model.dustDistance = 0;
    const heading = entity.heading ?? 0;
    for (const side of [-1, 1]) {
      const index = this.dust.next;
      this.dust.next = (index + 1) % DUST_COUNT;
      const back = 0.55 * scale;
      const x = entity.x - Math.sin(heading) * back + Math.cos(heading) * side * 0.3 * scale;
      const z = entity.z - Math.cos(heading) * back - Math.sin(heading) * side * 0.3 * scale;
      this.dust.position.set([x, this.world.elevation(x, z) + 0.45, z], index * 3);
      this.dust.drift.set([(Math.random() - 0.5) * 0.3 - Math.sin(heading) * 0.25, 0.32 + Math.random() * 0.2,
        (Math.random() - 0.5) * 0.3 - Math.cos(heading) * 0.25], index * 3);
      this.dust.life[index] = 1;
    }
  }

  updateDust() {
    const now = performance.now();
    const dt = Math.max(0, Math.min(0.1, (now - this.dust.clock) / 1000));
    this.dust.clock = now;
    const { position, color, life, drift, points } = this.dust;
    for (let index = 0; index < DUST_COUNT; index++) {
      if (life[index] > 0) {
        life[index] = Math.max(0, life[index] - dt / DUST_LIFETIME);
        for (let axis = 0; axis < 3; axis++) position[index * 3 + axis] += drift[index * 3 + axis] * dt;
      }
      color.set([0.76, 0.68, 0.55, life[index] * 0.75], index * 4);
    }
    points.geometry.getAttribute('position').needsUpdate = true;
    points.geometry.getAttribute('color').needsUpdate = true;
    // Orthographic camera: size puffs in world units converted to screen pixels.
    const { camera } = this;
    points.material.size = 0.9 * this.renderer.domElement.clientHeight * camera.zoom / (camera.top - camera.bottom);
  }

  animateUplink(visual, building, time) {
    const { dish, rocket, exhaust } = visual.userData;
    const launched = Boolean(building.satellite);
    const flight = building.launch ? Math.max(0, 1 - building.launch.remaining / 6) : 0;
    if (building.progress >= 1 && building.health > 0) dish.rotation.y = time * 0.34 + building.id;
    rocket.visible = !launched;
    rocket.position.y = 0.32 + flight ** 2 * 13;
    exhaust.visible = flight > 0 && building.health > 0;
    exhaust.scale.y = 0.76 * (1 + 0.12 * Math.sin(time * 35));
  }

  drawVapor(time) {
    if (!this.vapor.visible) return;
    const positions = this.vapor.geometry.getAttribute('position');
    for (const [index, site] of this.ventSites.entries()) {
      for (let particle = 0; particle < 6; particle++) {
        const rise = (time * 0.34 + particle / 6 + site.phase) % 1;
        positions.setXYZ(index * 6 + particle, site.x + Math.sin(particle * 2.2) * rise * 0.56 + rise ** 2 * 0.8,
          site.y + 0.42 + rise * 2.75, site.z + Math.cos(particle * 2.2) * rise * 0.56);
      }
    }
    positions.needsUpdate = true;
    this.vapor.material.size = 17 + this.zoom * 11;
  }

  drawSpatialGuides(state, selection, tutorialTarget, mines = highlightedMines(state, selection)) {
    const station = state.buildings.find((building) => building.type === 'uplink' && selection.has(building.id));
    const plan = station?.satellite ? null : station?.surveyTarget;
    const radius = orbitalVision(state);
    const weaponRanges = [];
    for (const building of state.buildings) {
      const range = BUILDINGS[building.type].combat?.range;
      if (range && selection.has(building.id)) weaponRanges.push({ x: building.x, z: building.z, range });
    }
    for (const unit of state.units) {
      const range = UNITS[unit.type].combat?.range;
      if (range && unit.health > 0 && selection.has(unit.id)) weaponRanges.push({ x: unit.x, z: unit.z, range });
    }
    if (this.defensePreview) weaponRanges.push(this.defensePreview);
    const layers = [
      [this.missionMarker, tutorialTarget ? [tutorialTarget] : [], 1.7, 12],
      [this.surveyPlan, plan ? [plan] : [], radius, 56],
      [this.orbitalVision, state.satellites, radius, 56],
      [this.defenseRange, weaponRanges, 0, 64],
      [this.mineMarkers, mines, 2.15, 24],
    ];
    for (const [layer, points, radius, sides] of layers) {
      const key = points.map(({ x, z, range }) => `${x}/${z}/${range ?? radius}`).join(';');
      if (layer.userData.markerKey === key) continue;
      layer.userData.markerKey = key;
      layer.visible = Boolean(points.length);
      if (!layer.visible) continue;
      const vertices = [];
      for (const point of points) {
        this.addWaypointMarker(vertices, point, point.range ?? radius, sides);
        if (layer !== this.defenseRange) this.addWaypointMarker(vertices, point, layer === this.mineMarkers ? 2.47 : 0.82, 4);
      }
      this.updateRouteLine(layer, vertices);
    }
  }

  addMapBar(className) {
    const bar = document.createElement('div');
    bar.className = className;
    bar.append(document.createElement('span'));
    this.overlay.append(bar);
    return bar;
  }

  drawBuildBar(model, building, neighbor) {
    model.buildBarPosition = null;
    const upgrade = building.upgrade;
    const progress = upgrade ? 1 - upgrade.remaining / COMMAND_TIERS[upgrade.tier].time
      : building.launch ? 1 - building.launch.remaining / ORBITAL_SURVEY.time : building.progress;
    if (!model.root.visible || progress >= 1) {
      if (model.bar) model.bar.hidden = true;
      return;
    }
    const height = building.type === 'command' ? 3.5 : model.label ? model.label.height - 0.63 : 0.55 + model.visual.scale.y * 1.9;
    const { x, y } = this.screenAt(building, height);
    if (x < 0 || x > this.canvas.clientWidth || y < 0 || y > this.canvas.clientHeight) {
      if (model.bar) model.bar.hidden = true;
      return;
    }
    model.bar ??= this.addMapBar(neighbor ? 'build-progress neighbor' : 'build-progress');
    model.buildBarPosition = { x, y };
    model.bar.hidden = false;
    model.bar.classList.toggle('waiting', Boolean(building.materialShortage));
    model.bar.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    model.bar.firstElementChild.style.transform = `scaleX(${progress})`;
  }

  drawHealthBar(model, entity, maximum, selected) {
    model.healthBarTop = null;
    if (!model.root.visible || !(maximum > 0) || (entity.health >= maximum && !selected)) {
      if (model.healthBar) model.healthBar.hidden = true;
      return;
    }
    const progress = model.buildBarPosition;
    const at = progress ?? this.screenAt(entity, model.roof * model.visual.scale.y + 0.24);
    const y = at.y - (progress ? 9 : 0);
    if (at.x < 0 || at.x > this.canvas.clientWidth || y < 0 || y > this.canvas.clientHeight) {
      if (model.healthBar) model.healthBar.hidden = true;
      return;
    }
    const ratio = THREE.MathUtils.clamp(entity.health / maximum, 0, 1);
    const size = entity.progress === undefined ? 'health-bar' : 'health-bar health-bar--structure';
    const bar = model.healthBar ??= this.addMapBar(size);
    bar.hidden = false;
    model.healthBarTop = y - 5;
    bar.dataset.level = ratio <= 0.30 ? 'critical' : ratio <= 0.60 ? 'low' : 'healthy';
    bar.style.transform = `translate(${at.x}px, ${y}px) translate(-50%, -100%)`;
    bar.firstElementChild.style.transform = `scaleX(${ratio})`;
  }

  drawOrders(state, selection, target) {
    const route = [];
    const rally = [];
    const patrols = new Map();
    for (const unit of state.units) {
      if (!selection.has(unit.id) || !unit.order) continue;
      const task = unitTask(unit);
      if (task?.kind === 'harvestPatrol') patrols.set(task.area, task.corners);
      const destination = (order) => order.destination || order.building || order.target || order;
      const destinations = [...(unit.route?.points ?? [destination(unit.order)]), ...unit.queuedOrders.map(destination)];
      this.addRoute(route, unit, destinations.filter(({ x, z }) => Number.isFinite(x) && Number.isFinite(z)));
    }
    for (const building of state.buildings) {
      if (selection.has(building.id) && building.rallyPoints?.length) this.addRoute(rally, building, building.rallyPoints);
    }
    if (target && target.until > performance.now()) {
      this.addWaypointMarker(route, target, 0.7, 12);
    }
    this.updateRouteLine(this.route, route);
    this.updateRouteLine(this.rallyRoute, rally);
    const patrol = [];
    for (const corners of patrols.values()) this.addRoute(patrol, corners[0], [...corners.slice(1), corners[0]]);
    this.harvestPatrolRoute.visible = Boolean(patrol.length);
    if (patrol.length) this.updateRouteLine(this.harvestPatrolRoute, patrol);
  }

  addRoute(vertices, start, destinations) {
    let origin = start;
    for (const [index, destination] of destinations.entries()) {
      const length = distance(origin, destination);
      const pointAt = (ratio) => ({
        x: origin.x + (destination.x - origin.x) * ratio,
        z: origin.z + (destination.z - origin.z) * ratio,
      });
      for (let step = 0; step < length; step += 0.65) {
        this.addRoutePoint(vertices, pointAt(step / length));
        this.addRoutePoint(vertices, pointAt(Math.min(length, step + 0.37) / length));
      }
      this.addWaypointMarker(vertices, destination, index === destinations.length - 1 ? 0.58 : 0.39, 4);
      origin = destination;
    }
  }

  addWaypointMarker(vertices, point, radius, sides) {
    const at = (index) => ({
      x: point.x + Math.cos(index / sides * Math.PI * 2) * radius,
      z: point.z + Math.sin(index / sides * Math.PI * 2) * radius,
    });
    for (let index = 0; index < sides; index++) {
      this.addRoutePoint(vertices, at(index));
      this.addRoutePoint(vertices, at(index + 1));
    }
  }

  addRoutePoint(vertices, { x, z }) {
    vertices.push(x, this.world.elevation(x, z) + 0.15, z);
  }

  updateRouteLine(line, vertices) {
    let positions = line.geometry.getAttribute('position');
    if (!positions || positions.array.length < vertices.length) {
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry();
      const capacity = Math.max(342, vertices.length * 2 / 3);
      positions = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
      positions.setUsage(THREE.DynamicDrawUsage);
      line.geometry.setAttribute('position', positions);
    }
    positions.array.set(vertices);
    positions.needsUpdate = true;
    line.geometry.setDrawRange(0, vertices.length / 3);
  }
}
