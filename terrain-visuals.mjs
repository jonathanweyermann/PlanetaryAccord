import { BIOMES } from './world.mjs';
import { randomFrom, terrainNoise } from './planet.mjs';

export const terrainBiomes = Object.keys(BIOMES);
export const TERRAIN_DETAIL_SIZE = 512;

function rgbLinear(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [16, 8, 0].map((shift) => {
    const component = ((value >> shift) & 255) / 255;
    return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
  });
}

const paint = {
  plains: ['#285823', '#519335'],
  forest: ['#1f462c', '#386f36'],
  mountain: ['#536546', '#948268'],
  desert: ['#b58a50', '#e0bb76'],
  crystal: ['#666c91', '#a09abe'],
  volcanic: ['#76564c', '#ac8061'],
};
const palette = terrainBiomes.map((biome) => paint[biome].map(rgbLinear));
const stone = ['#514d42', '#a18b6e'].map(rgbLinear);

export function terrainPaint(x, z, seed) {
  const drift = terrainNoise(x * 0.065, z * 0.065, seed + 419) - 0.5;
  const broad = terrainNoise((x + z * 0.22) * 0.10, (z - x * 0.24) * 0.16 + drift, seed + 721);
  const flecks = terrainNoise(x * 0.34 + drift, z * 0.29, seed + 892);
  return 0.10 + 0.72 * broad + 0.18 * flecks;
}

export function blendTerrainColor(weights, ridge, stroke, output) {
  for (let channel = 0; channel < 3; channel++) {
    let color = 0;
    for (let biome = 0; biome < palette.length; biome++) {
      const [shade, light] = palette[biome];
      color += weights[biome] * (shade[channel] + (light[channel] - shade[channel]) * stroke);
    }
    const rock = stone[0][channel] + (stone[1][channel] - stone[0][channel]) * stroke;
    output[channel] = color + (rock - color) * ridge;
  }
}

export function terrainDetailPixels() {
  const size = TERRAIN_DETAIL_SIZE;
  // Pack grass blades, sand ripples, rock seams and grit into a single repeating texture.
  const pixels = new Uint8Array(size * size * 4);
  const random = randomFrom(17263);
  const stoneCells = 18;
  const joints = Array.from({ length: stoneCells ** 2 }, () => ({
    x: 0.17 + random() * 0.66, z: 0.17 + random() * 0.66, value: random(),
  }));
  for (let row = 0; row < size; row++) {
    const v = row / size;
    const z = v * stoneCells;
    const baseZ = Math.floor(z);
    for (let column = 0; column < size; column++) {
      const u = column / size;
      const x = u * stoneCells;
      const baseX = Math.floor(x);
      const index = (row * size + column) * 4;
      const ripple = Math.cos(Math.PI * 2 * (u * 5 + v * 24 + 0.24 * Math.sin(Math.PI * 2 * (u * 2 - v * 3))));
      let nearest = Infinity;
      let second = Infinity;
      let shade = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cellX = baseX + dx;
          const cellZ = baseZ + dz;
          const joint = joints[((cellZ + stoneCells) % stoneCells) * stoneCells + (cellX + stoneCells) % stoneCells];
          const gap = (cellX + joint.x - x) ** 2 + (cellZ + joint.z - z) ** 2;
          if (gap < nearest) { second = nearest; nearest = gap; shade = joint.value; }
          else if (gap < second) second = gap;
        }
      }
      const seam = Math.max(0, 1 - (second - nearest) / 0.085);
      pixels[index] = 128;
      pixels[index + 1] = Math.round(128 + ripple * 26 + Math.max(0, ripple) ** 9 * 35);
      pixels[index + 2] = Math.round(123 + shade * 49 - seam * 71);
      pixels[index + 3] = 128;
    }
  }

  function brushMark(x, z, length, width, angle, channel, value) {
    const radius = Math.ceil(Math.hypot(length, width));
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const along = (dx * cos + dz * sin) / length;
        const across = (dz * cos - dx * sin) / width;
        const edge = Math.max(0, 1 - along ** 2 - across ** 2);
        if (!edge) continue;
        const index = (((z + dz + size) % size) * size + (x + dx + size) % size) * 4 + channel;
        const mix = Math.min(1, edge * 2.8);
        pixels[index] = Math.round(pixels[index] + (value - pixels[index]) * mix);
      }
    }
  }

  for (let tuft = 0; tuft < 1850; tuft++) {
    const x = Math.floor(random() * size);
    const z = Math.floor(random() * size);
    const heading = random() * Math.PI * 2;
    brushMark(x, z, 3 + random() * 5, 1.6 + random() * 2, heading, 0, 60 + Math.round(random() * 42));
    for (let blade = 0; blade < 4; blade++) {
      brushMark(x + Math.floor(random() * 7) - 3, z + Math.floor(random() * 7) - 3,
        2.3 + random() * 4.9, 0.85 + random() * 0.75, heading + (random() - 0.5) * 2.2, 0, 148 + Math.round(random() * 76));
    }
  }
  for (let chip = 0; chip < 2600; chip++) {
    brushMark(Math.floor(random() * size), Math.floor(random() * size), 1.2 + random() * 3.6,
      0.8 + random() * 2.4, random() * Math.PI, 3, random() < 0.5 ? 185 : 72);
  }
  return pixels;
}

export function toSrgbByte(value) {
  return 255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);
}
