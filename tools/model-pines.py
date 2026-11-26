"""Model and export the pine variants used for harvestable trees.

Run with blender --background --factory-startup --python tools/model-pines.py.
Pass -- --preview to render a contact sheet as well.
"""

import json
from math import cos, sin, tau
from pathlib import Path
from random import Random
import sys

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]


def linear_color(hex_color):
    rgb = (int(hex_color[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb)


class Pine:
    def __init__(self, seed, height, reach, low_crown, needles):
        self.random = Random(seed)
        self.height = height
        self.reach = reach
        self.low_crown = low_crown
        self.needles = linear_color(needles)
        self.bark = linear_color("68513c")
        self.lean = self.random.uniform(-0.14, 0.14)
        self.vertices = []
        self.faces = []
        self.colors = []

    def center(self, height):
        fraction = height / self.height
        return self.lean * fraction ** 2, 0.075 * fraction * sin(fraction * 4), height

    def add(self, points, faces, color, lighting):
        first = len(self.vertices)
        self.vertices.extend(points)
        self.faces.extend(tuple(first + i for i in face) for face in faces)
        self.colors.extend(tuple(c * value for c in color) for value in lighting)

    def trunk(self):
        rng = self.random
        sides = 7
        levels = [(-0.10, 0.112), (0.12, 0.101), (0.48, 0.070), (0.73, 0.044), (0.95, 0.018)]
        points, faces, shading = [], [], []
        bark_strips = [rng.uniform(0.55, 1.16) for _ in range(sides)]
        for level, radius in levels:
            cx, cy, z = self.center(level * self.height)
            for i in range(sides):
                angle = tau * i / sides
                width = radius * rng.uniform(0.84, 1.18)
                points.append((cx + width * cos(angle), cy + width * sin(angle), z))
                shading.append(bark_strips[i] * rng.uniform(0.81, 1.13))
        for tier in range(len(levels) - 1):
            for i in range(sides):
                a, b = tier * sides + i, tier * sides + (i + 1) % sides
                faces.append((a, b, b + sides, a + sides))
        faces.append(tuple(range((len(levels) - 1) * sides, len(levels) * sides)))
        self.add(points, faces, self.bark, shading)

        for i in range(4):
            angle = i * tau / 4 + rng.uniform(-0.35, 0.35)
            dx, dy = cos(angle), sin(angle)
            reach = rng.uniform(0.16, 0.27)
            self.add(
                [(0, 0, 0.18), (-dy * 0.065, dx * 0.065, -0.035),
                 (dy * 0.065, -dx * 0.065, -0.035), (dx * reach, dy * reach, -0.07)],
                [(0, 2, 3), (0, 3, 1)], self.bark, [1.05, 0.65, 0.71, 0.76],
            )

    def bough(self, height, angle, length, width, rise):
        rng = self.random
        cx, cy, cz = self.center(height)
        dx, dy = cos(angle), sin(angle)
        sway = rng.uniform(-0.12, 0.12) * length

        def point(distance, side, vertical):
            side += sway * distance ** 2
            return cx + dx * length * distance - dy * side, cy + dy * length * distance + dx * side, cz + vertical

        points = [point(0.015, 0.0, 0.035)]
        for travel, breadth, elevation in [(0.27, 0.88, 0.0), (0.65, 0.62, rise * 0.40)]:
            w = width * breadth
            points.extend((
                point(travel, 0, elevation + length * (0.31 - travel * 0.22)),
                point(travel + 0.05, -w, elevation - length * rng.uniform(0.01, 0.11)),
                point(travel - 0.025, 0, elevation - length * 0.13),
                point(travel - 0.04, w * rng.uniform(0.73, 1.22), elevation - length * 0.045),
            ))
        points.append(point(1.0, 0.0, rise))
        faces = []
        for i in range(4):
            j = (i + 1) % 4
            faces.extend(((0, 1 + j, 1 + i), (1 + i, 1 + j, 5 + j, 5 + i), (5 + i, 5 + j, 9)))
        tint = rng.uniform(0.79, 1.20)
        shading = [0.53, 0.94, 0.69, 0.40, 0.70, 1.12, 0.87, 0.52, 0.88, 1.11]
        self.add(points, faces, self.needles, [tint * value for value in shading])

        if length > 0.33:
            # Forked sprays break up the straight sides of the larger boughs.
            for sign in (-1, 1):
                progress = rng.uniform(0.43, 0.58)
                lip = rise * progress * 0.5
                self.add([
                    point(progress - 0.12, width * sign * 0.39, lip + length * 0.052),
                    point(progress, width * sign * 0.56, lip + length * 0.086),
                    point(progress + 0.18, width * sign * 1.28, lip - length * 0.015),
                    point(progress + 0.17, width * sign * 0.49, lip - length * 0.035),
                ], [(0, 1, 2), (0, 2, 3)] if sign > 0 else [(0, 2, 1), (0, 3, 2)],
                    self.needles, [0.79 * tint, 0.98 * tint, 1.18 * tint, 0.71 * tint])

    def make(self, name):
        self.trunk()
        rng = self.random
        rows = [(0.00, 0.93, 6), (0.18, 1.00, 6), (0.38, 0.79, 5),
                (0.57, 0.65, 5), (0.75, 0.48, 4), (0.88, 0.30, 3)]
        for fraction, span, count in rows:
            start = rng.uniform(0, tau)
            for i in range(count):
                height = self.low_crown + (self.height - self.low_crown) * fraction + rng.uniform(-0.07, 0.07)
                angle = start + i * tau / count + rng.uniform(-0.22, 0.22)
                length = span * self.reach * rng.uniform(0.72, 1.16)
                self.bough(height, angle, length, length * rng.uniform(0.23, 0.37),
                           length * rng.uniform(-0.19, 0.15))
        # A compact leader closes the crown above the upper whorl.
        height = self.height * 0.87
        x, y, _ = self.center(height)
        self.add([(x + cos(i * tau / 5) * self.reach * 0.19, y + sin(i * tau / 5) * self.reach * 0.19, height)
                  for i in range(5)] + [self.center(self.height + 0.035)],
                 [(i, (i + 1) % 5, 5) for i in range(5)], self.needles, [0.72] * 5 + [1.17])

        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(self.vertices, [], self.faces)
        mesh.update()
        colors = mesh.color_attributes.new(name="Canopy and bark", type="FLOAT_COLOR", domain="POINT")
        colors.data.foreach_set("color", [c for rgb in self.colors for c in (*rgb, 1.0)])
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        return obj


def export_geometry(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    color_data = mesh.color_attributes["Canopy and bark"].data
    # Blender is Z-up. This rotation maps it into the game's Y-up coordinates.
    positions = [round(c, 5) for v in mesh.vertices for c in (v.co.x, v.co.z, -v.co.y)]
    indices = [i for triangle in mesh.loop_triangles for i in triangle.vertices]
    colors = [round(c, 6) for entry in color_data for c in entry.color[:3]]

    def attribute(values):
        return {"itemSize": 3, "type": "Float32Array", "array": values}

    return {"name": obj.name, "data": {
        "attributes": {"position": attribute(positions), "color": attribute(colors)},
        "index": {"type": "Uint16Array", "array": indices},
    }}


def preview(trees):
    material = bpy.data.materials.new("Pine colors")
    material.use_nodes = True
    layer = material.node_tree.nodes.new("ShaderNodeVertexColor")
    layer.layer_name = "Canopy and bark"
    shader = material.node_tree.nodes["Principled BSDF"]
    shader.inputs["Roughness"].default_value = 0.94
    material.node_tree.links.new(layer.outputs["Color"], shader.inputs["Base Color"])
    for i, tree in enumerate(trees):
        tree.data.materials.append(material)
        tree.location.x = (i - 1) * 2.16

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 40
    scene.cycles.use_denoising = True
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.63
    scene.view_settings.view_transform = "Standard"
    bpy.ops.mesh.primitive_plane_add(size=200)
    floor = bpy.data.materials.new("Ground")
    floor.diffuse_color = (0.07, 0.09, 0.05, 1)
    bpy.context.object.data.materials.append(floor)
    bpy.ops.object.light_add(type="SUN", rotation=(0.49, -0.57, -0.28))
    bpy.context.object.data.energy = 2.3
    bpy.context.object.data.angle = 0.13
    bpy.ops.object.camera_add(location=(0.65, -7.9, 6.5))
    camera = bpy.context.object
    camera.rotation_euler = (Vector((0, 0, 0.98)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 7.0
    scene.camera = camera
    scene.render.resolution_x = 1000
    scene.render.resolution_y = 510
    scene.render.resolution_percentage = 100
    scene.render.filepath = str(ROOT / ".pines-preview.png")
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    trees = [
        Pine(485, 2.52, 0.80, 0.63, "456b3a").make("Ridge pine"),
        Pine(172, 2.20, 0.91, 0.77, "416c48").make("Spreading pine"),
        Pine(923, 2.04, 0.72, 0.46, "52733d").make("Young pine"),
    ]
    assets = ROOT / "assets" / "models"
    assets.mkdir(parents=True, exist_ok=True)
    (assets / "pines.json").write_text(json.dumps([export_geometry(obj) for obj in trees], separators=(",", ":")),
                                      encoding="utf-8")
    if "--preview" in sys.argv:
        preview(trees)
