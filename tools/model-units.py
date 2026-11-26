"""Build the game unit meshes in Blender and export their runtime geometry.

Run with blender --background --factory-startup --python tools/model-units.py
Add -- --preview to render a lineup.
"""

import json
from math import cos, sin, tau
from pathlib import Path
import sys

import bmesh
import bpy
from mathutils import Euler, Vector


ROOT = Path(__file__).resolve().parents[1]
STEEL = "788c96"
DARK = "26343b"
RUBBER = "22282b"
SHADOW = "141e23"
SHELL = "b4c3c5"
BLUE = "5de6fa"
LAMP = "ffd48b"


def linear_color(hex_color):
    channels = (int(hex_color[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels)


class Model:
    def __init__(self, paint):
        self.paint = paint
        self.parts = {}
        self.pivots = {}

    def append(self, points, faces, color, part="hull"):
        vertices, polygons, colors = self.parts.setdefault(part, ([], [], []))
        first = len(vertices)
        tint = linear_color(color)
        vertices.extend(points)
        polygons.extend(tuple(first + i for i in face) for face in faces)
        for _, _, z in points:
            lift = 1 if part == "lights" else 0.88 + 0.15 * min(1, max(0, z))
            colors.append(tuple(c * lift for c in tint))

    def from_bmesh(self, bm, transform, color, part="hull"):
        bm.verts.index_update()
        self.append([tuple(transform(vertex.co)) for vertex in bm.verts],
                    [tuple(vertex.index for vertex in face.verts) for face in bm.faces], color, part)
        bm.free()

    def box(self, center, size, color, bevel=0.012, rotation=(0, 0, 0), part="hull"):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1)
        for vertex in bm.verts:
            vertex.co = Vector(tuple(a * b for a, b in zip(vertex.co, size)))
        if bevel:
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=min(bevel, min(size) * 0.31),
                            segments=1, affect="EDGES")
        orientation = Euler(rotation).to_matrix()
        location = Vector(center)
        self.from_bmesh(bm, lambda point: orientation @ point + location, color, part)

    def cylinder(self, start, end, lower, upper, color, sides=10, part="hull"):
        a, b = Vector(start), Vector(end)
        heading = b - a
        rotation = heading.to_track_quat("Z", "Y")
        def ring(center, radius):
            return [tuple(center + rotation @ Vector((cos(i * tau / sides) * radius,
                                                       sin(i * tau / sides) * radius, 0)))
                    for i in range(sides)]

        points = ring(a, lower)
        if upper == 0:
            points.append(tuple(b))
            faces = [(i, (i + 1) % sides, sides) for i in range(sides)]
            self.append(points, [*faces, tuple(reversed(range(sides)))], color, part)
            return
        points.extend(ring(b, upper))
        faces = [(i, (i + 1) % sides, (i + 1) % sides + sides, i + sides) for i in range(sides)]
        faces.extend((tuple(reversed(range(sides))), tuple(range(sides, 2 * sides))))
        self.append(points, faces, color, part)

    def capsule(self, center, radii, color, tilt=(0, 0, 0), part="hull", subdivisions=2):
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=1)
        orientation = Euler(tilt).to_matrix()
        location = Vector(center)
        self.from_bmesh(bm, lambda point: orientation @ Vector(tuple(a * b for a, b in zip(point, radii))) + location,
                        color, part)

    def loft(self, levels, color, part="hull"):
        # Sections are (height, width, depth, center forward). Cut corners catch directional light.
        outline = [(-0.36, -0.5), (0.36, -0.5), (0.5, -0.34), (0.5, 0.34),
                   (0.36, 0.5), (-0.36, 0.5), (-0.5, 0.34), (-0.5, -0.34)]
        points = [(x * width, y * depth + forward, height)
                  for height, width, depth, forward in levels for x, y in outline]
        faces = [(row * 8 + i, row * 8 + (i + 1) % 8, (row + 1) * 8 + (i + 1) % 8, (row + 1) * 8 + i)
                 for row in range(len(levels) - 1) for i in range(8)]
        faces.extend((tuple(reversed(range(8))), tuple(range(len(points) - 8, len(points)))))
        self.append(points, faces, color, part)

    def lamp(self, center, size, color=BLUE):
        self.box(center, size, color, 0, part="lights")

    def wheel(self, x, y, z, radius, width, side):
        inner, outer = x - side * width / 2, x + side * width / 2
        self.cylinder((inner, y, z), (outer, y, z), radius * 0.96, radius, RUBBER, 12)
        self.cylinder((outer, y, z), (outer + side * 0.024, y, z), radius * 0.69, radius * 0.62, STEEL)
        self.cylinder((outer + side * 0.022, y, z), (outer + side * 0.037, y, z),
                      radius * 0.32, radius * 0.30, self.paint, 8)

    def tracks(self, x, half_length, width):
        profile = [(-half_length, 0.13), (-half_length, 0.30), (-half_length + 0.14, 0.43),
                   (half_length - 0.14, 0.43), (half_length, 0.30), (half_length, 0.13),
                   (half_length - 0.13, 0.045), (-half_length + 0.13, 0.045)]
        profile.reverse()
        for side in (-1, 1):
            center = x * side
            points = [(center + offset, y, z) for offset in (-width / 2, width / 2) for y, z in profile]
            faces = [(i, (i + 1) % 8, (i + 1) % 8 + 8, i + 8) for i in range(8)]
            faces += [tuple(reversed(range(8))), tuple(range(8, 16))]
            self.append(points, faces, RUBBER)
            for row in range(5):
                y = (row - 2) * (half_length - 0.16) / 2
                self.wheel(center + side * width * 0.40, y, 0.225, 0.118, 0.045, side)
            for row in range(8):
                y = (row - 3.5) * (half_length - 0.15) / 3.5
                self.box((center, y, 0.434), (width + 0.035, 0.031, 0.033), "455459", 0)

    def exhaust(self, x, y, z, radius, color=BLUE):
        self.cylinder((x, y, z), (x, y - 0.13, z), radius, radius * 0.84, DARK, 10)
        self.cylinder((x, y - 0.129, z), (x, y - 0.136, z), radius * 0.65, radius * 0.65, color, 10, part="lights")


def rover():
    model = Model("dca454")
    model.loft([(0.16, 0.67, 1.02, 0), (0.36, 0.76, 1.21, 0), (0.47, 0.65, 1.11, 0)], DARK)
    for side in (-1, 1):
        for y in (-0.44, -0.03, 0.39):
            model.wheel(side * 0.385, y, 0.183, 0.175, 0.18, side)
        model.box((side * 0.36, -0.035, 0.394), (0.21, 1.12, 0.086), model.paint, 0.038)
        model.box((side * 0.32, 0.496, 0.352), (0.14, 0.21, 0.16), STEEL, 0.029)
        model.lamp((side * 0.29, 0.607, 0.37), (0.12, 0.027, 0.044), LAMP)
    model.loft([(0.41, 0.58, 0.58, 0.21), (0.69, 0.41, 0.42, 0.24), (0.76, 0.34, 0.34, 0.21)], model.paint)
    model.loft([(0.54, 0.44, 0.13, 0.454), (0.68, 0.35, 0.11, 0.375)], "32647c")
    model.box((0, 0.20, 0.756), (0.28, 0.27, 0.046), SHELL, 0.021)
    model.box((-0.155, -0.356, 0.513), (0.21, 0.31, 0.19), "94a69c", 0.028)
    model.box((0.13, -0.36, 0.52), (0.22, 0.23, 0.19), DARK, 0.029)
    for a, b in (((0.13, -0.40, 0.56), (0.13, -0.30, 0.92)),
                 ((0.13, -0.30, 0.92), (0.13, 0.10, 0.86)),
                 ((0.13, 0.10, 0.86), (0.13, 0.22, 0.73))):
        model.cylinder(a, b, 0.057, 0.042, model.paint, 8)
        model.capsule(b, (0.061, 0.066, 0.059), STEEL, subdivisions=1)
    model.box((0.13, 0.255, 0.712), (0.20, 0.149, 0.098), STEEL, 0.02)
    model.lamp((0.13, 0.325, 0.722), (0.09, 0.024, 0.034))
    return model


def speeder(pathfinder):
    model = Model("58a69d" if pathfinder else "d6e1db")
    reach = 0.48 if pathfinder else 0.385
    model.loft([(0.21, 0.32, 1.27, -0.02), (0.38, 0.64, 1.36, -0.03),
                (0.56, 0.46, 1.07, 0.02)], DARK)
    model.loft([(0.40, 0.52, 1.21, 0), (0.62, 0.40, 0.79, 0.06)], model.paint)
    model.loft([(0.59, 0.35, 0.57, 0.153), (0.73, 0.25, 0.32, 0.077)], "32647e")
    model.lamp((0, 0.606, 0.443), (0.22, 0.024, 0.029))
    for side in (-1, 1):
        x = side * reach
        model.box((x * 0.79, -0.14, 0.328), (0.27, 0.61, 0.11), STEEL, 0.028)
        model.box((x, -0.14, 0.298), (0.19, 0.87, 0.194), DARK, 0.058)
        model.box((x, -0.18, 0.444), (0.165, 0.66, 0.146), model.paint, 0.052)
        model.exhaust(x, -0.51, 0.298, 0.083)
        model.lamp((x, 0.29, 0.319), (0.105, 0.036, 0.045))
    if pathfinder:
        model.box((0, -0.31, 0.67), (0.31, 0.27, 0.14), STEEL, 0.032)
        model.cylinder((0, -0.31, 0.70), (0, -0.32, 0.96), 0.049, 0.031, DARK, 8)
        model.box((0, -0.32, 0.97), (0.26, 0.126, 0.082), model.paint, 0.026)
        model.lamp((0, -0.25, 0.97), (0.144, 0.024, 0.034), LAMP)
    return model


def survey_drone():
    model = Model("b5a3d8")
    model.loft([(0.42, 0.24, 0.42, 0.05), (0.59, 0.63, 1.03, 0),
                (0.79, 0.43, 0.77, 0)], model.paint)
    model.loft([(0.76, 0.41, 0.59, 0), (0.89, 0.25, 0.37, -0.055)], "627395")
    for side in (-1, 1):
        for row in (-1, 1):
            x, y = side * 0.43, row * 0.38
            model.cylinder((side * 0.16, row * 0.15, 0.67), (x, y, 0.60), 0.055, 0.045, STEEL, 8)
            model.cylinder((x, y, 0.47), (x, y, 0.61), 0.105, 0.15, DARK, 12)
            model.cylinder((x, y, 0.595), (x, y, 0.64), 0.155, 0.149, model.paint, 12)
            model.cylinder((x, y, 0.46), (x, y, 0.47), 0.079, 0.079, "c6aaff", 12, part="lights")
        model.lamp((side * 0.142, 0.45, 0.62), (0.10, 0.026, 0.042))
    model.capsule((0, 0.215, 0.477), (0.153, 0.171, 0.123), SHADOW)
    model.lamp((0, 0.361, 0.463), (0.105, 0.033, 0.063))
    return model


def soldier(sentinel):
    model = Model("5c98bc" if sentinel else "accac1")
    reach = 0.22 if sentinel else 0.18
    armor_size = 1.12 if sentinel else 0.94
    model.loft([(0.41, 0.24, 0.19, -0.016), (0.65, 0.41 * armor_size, 0.27, 0),
                (0.82, 0.35 * armor_size, 0.24, 0.019)], model.paint)
    model.box((0, 0.14, 0.685), (0.255 * armor_size, 0.07, 0.20), SHELL, 0.031)
    model.box((0, -0.18, 0.64), (0.32, 0.18, 0.38), DARK, 0.051)
    model.capsule((0, 0.035, 0.97), (0.154, 0.149, 0.171), model.paint)
    model.box((0, 0.169, 0.984), (0.21, 0.077, 0.089), "2d556a", 0.028)
    model.lamp((0, 0.21, 0.989), (0.166, 0.016, 0.039))
    for side in (-1, 1):
        model.box((side * 0.112, 0.021 + side * 0.046, 0.084), (0.141, 0.283, 0.153), RUBBER, 0.028)
        model.box((side * 0.110, side * 0.044, 0.28), (0.145, 0.161, 0.25), DARK, 0.035)
        model.box((side * 0.109, 0.081 + side * 0.043, 0.259), (0.116, 0.055, 0.20), model.paint, 0.023)
        model.capsule((side * reach, 0.009, 0.739), (0.119 * armor_size, 0.114, 0.119), model.paint)
        model.cylinder((side * (reach + 0.012), 0.01, 0.70), (side * reach, 0.105, 0.55),
                       0.075, 0.056, DARK, 8)
        model.cylinder((side * reach, 0.102, 0.56), (side * 0.146, 0.242, 0.615), 0.068, 0.054, model.paint, 8)
    model.box((0.132, 0.237, 0.610), (0.098 if sentinel else 0.078, 0.41, 0.132), DARK, 0.019)
    model.box((0.131, 0.294, 0.675), (0.086, 0.22, 0.041), STEEL, 0.011)
    model.cylinder((0.132, 0.407, 0.625), (0.132, 0.566, 0.625), 0.039, 0.029, STEEL, 8)
    if sentinel:
        model.box((0.132, 0.51, 0.63), (0.117, 0.115, 0.097), DARK, 0.024)
        model.box((-0.248, 0.096, 0.616), (0.108, 0.18, 0.255), model.paint, 0.027)
    return model


def armor(kind):
    palettes = {"skirmisher": "71a594", "vanguard": "8babb4", "siege": "a395b6"}
    model = Model(palettes[kind])
    siege = kind == "siege"
    light = kind == "skirmisher"
    half = 0.70 if siege else 0.55
    model.loft([(0.16, 0.62, half * 1.63, 0), (0.35, 0.76, half * 2.10, 0),
                (0.54, 0.66, half * 1.81, -0.035)], model.paint)
    if light:
        for side in (-1, 1):
            for y in (-0.4, 0.38):
                model.wheel(side * 0.408, y, 0.181, 0.18, 0.18, side)
            model.box((side * 0.386, -0.014, 0.393), (0.19, 0.99, 0.10), STEEL, 0.024)
    else:
        model.tracks(0.384, half, 0.213)
        for side in (-1, 1):
            model.box((side * 0.386, -0.05, 0.46), (0.245, half * 1.62, 0.09), model.paint, 0.037)
            model.box((side * 0.47, -0.048, 0.444), (0.09, half * 1.28, 0.122), STEEL, 0.013)
    for side in (-1, 1):
        model.lamp((side * 0.251, half * 0.966, 0.423), (0.102, 0.032, 0.048), LAMP)
        model.exhaust(side * 0.224, -half * 0.77, 0.387, 0.069, "ff8c58" if siege else BLUE)
    model.cylinder((0, -0.12, 0.46), (0, -0.12, 0.60), 0.26, 0.25, DARK, 12)
    turret = Model(model.paint)
    if siege:
        turret.box((0, -0.134, 0.654), (0.44, 0.58, 0.25), DARK, 0.033)
        turret.box((0, 0.09, 0.79), (0.36, 0.64, 0.225), model.paint, 0.054)
        for side in (-1, 1):
            turret.box((side * 0.103, 0.516, 0.802), (0.106, 0.938, 0.12), STEEL, 0.023)
            turret.lamp((side * 0.082, 0.61, 0.867), (0.052, 0.49, 0.013), "bf99ff")
            turret.box((side * 0.108, 1.00, 0.795), (0.155, 0.22, 0.18), DARK, 0.03)
            model.box((side * 0.34, -0.56, 0.522), (0.18, 0.33, 0.144), DARK, 0.028)
            model.cylinder((side * 0.39, -0.58, 0.542), (side * 0.48, -0.75, 0.165),
                           0.072, 0.047, STEEL, 8)
    else:
        turret.loft([(0.58, 0.41, 0.47, -0.10), (0.78, 0.48, 0.59, -0.09),
                    (0.91 if not light else 0.83, 0.32, 0.40, -0.12)], model.paint)
        offsets = (0,) if light else (-0.128, 0.128)
        for x in offsets:
            turret.box((x, 0.25, 0.737), (0.15, 0.20, 0.165), DARK, 0.026)
            turret.cylinder((x, 0.255, 0.737), (x, 0.782 if light else 0.654, 0.737), 0.061, 0.053, STEEL)
            turret.cylinder((x, 0.715 if light else 0.61, 0.737), (x, 0.805 if light else 0.718, 0.737),
                           0.086, 0.081, DARK, 8)
            turret.cylinder((x, 0.806 if light else 0.719, 0.737), (x, 0.811 if light else 0.724, 0.737),
                           0.043, 0.043, SHADOW, 8)
        turret.lamp((0, 0.204, 0.805), (0.137, 0.039, 0.054))
        if light:
            model.cylinder((-0.13, -0.359, 0.62), (-0.15, -0.379, 0.95), 0.029, 0.018, STEEL, 8)
        else:
            turret.box((0, -0.39, 0.72), (0.30, 0.24, 0.18), DARK, 0.029)
    model.parts["turret"] = turret.parts["hull"]
    model.parts["turretLights"] = turret.parts["lights"]
    model.pivots["turret"] = model.pivots["turretLights"] = (0, -0.12, 0.58)
    return model


def reptile(ancient):
    model = Model("765266" if ancient else "6c7b51")
    hide, armor_color, belly = model.paint, "9c7188" if ancient else "818d60", "ad9574"
    model.capsule((0, -0.15, 0.52), (0.44, 0.79, 0.42), hide)
    model.capsule((0, 0.09, 0.402), (0.344, 0.69, 0.24), belly)
    model.capsule((0, 0.50, 0.63), (0.33, 0.52, 0.315), armor_color, (-0.19, 0, 0))
    model.capsule((0, 0.90, 0.66), (0.315, 0.39, 0.251), hide)
    model.capsule((0, 1.16, 0.56), (0.245, 0.37, 0.14), armor_color)
    model.capsule((0, 1.14, 0.46), (0.253, 0.35, 0.105), DARK)
    model.capsule((0, 1.16, 0.396), (0.23, 0.31, 0.098), belly)
    for side in (-1, 1):
        x = side * 0.240
        model.capsule((x, 1.066, 0.719), (0.094, 0.175, 0.079), armor_color)
        model.capsule((x + side * 0.041, 1.114, 0.67), (0.031, 0.057, 0.038), "ffd099", part="lights")
        for y in (0.97, 1.15, 1.31):
            model.cylinder((side * 0.186, y, 0.492), (side * 0.181, y + 0.014, 0.403), 0.027, 0.0, "e7ce9f", 5)
        for y in (-0.52, 0.42):
            model.capsule((side * 0.413, y, 0.39), (0.215, 0.235, 0.286), hide, (0, side * -0.48, 0))
            model.cylinder((side * 0.51, y, 0.26), (side * 0.605, y + 0.095, 0.103), 0.129, 0.083, armor_color, 8)
            model.capsule((side * 0.607, y + 0.153, 0.082), (0.13, 0.182, 0.076), hide)
            for offset in (-0.078, 0, 0.078):
                model.cylinder((side * 0.607 + offset, y + 0.243, 0.081),
                               (side * 0.607 + offset * 1.2, y + 0.390, 0.034), 0.032, 0.0, "d3be95", 5)
        if ancient:
            model.cylinder((side * 0.178, 0.85, 0.807), (side * 0.314, 0.69, 1.15), 0.092, 0.012, "d9b897", 7)
    for i in range(6):
        y = 0.54 - i * 0.224
        z = 0.87 - i * 0.028
        model.cylinder((0, y, z), (0, y - 0.16, z + (0.36 if ancient else 0.24) - i * 0.014),
                       0.127 - i * 0.012, 0.008, armor_color, 6)
    model.pivots["tail"] = (0, -0.60, 0.491)
    tail = [(0, -0.56, 0.49, 0.27), (0, -0.90, 0.45, 0.25), (0.018, -1.23, 0.37, 0.181),
            (0.078, -1.59, 0.349, 0.13), (0.198, -1.91, 0.382, 0.078), (0.32, -2.21, 0.49, 0.008)]
    sides = 9
    centers = [Vector(section[:3]) for section in tail]
    points = []
    for i, center in enumerate(centers):
        tangent = centers[min(i + 1, len(tail) - 1)] - centers[max(0, i - 1)]
        orientation = tangent.to_track_quat("Z", "Y")
        radius = tail[i][3]
        points.extend(tuple(center + orientation @ Vector((radius * cos(k * tau / sides),
                                                           radius * sin(k * tau / sides), 0)))
                      for k in range(sides))
    faces = [(row * sides + i, row * sides + (i + 1) % sides,
              (row + 1) * sides + (i + 1) % sides, (row + 1) * sides + i)
             for row in range(len(tail) - 1) for i in range(sides)]
    faces.extend((tuple(reversed(range(sides))), tuple(range(len(points) - sides, len(points)))))
    model.append(points, faces, hide, part="tail")
    for x, y, z, radius in tail[1:5]:
        model.cylinder((x, y, z + radius * 0.8), (x, y - 0.13, z + radius * (1.7 if ancient else 1.46)),
                       radius * 0.5, 0.005, armor_color, 6, part="tail")
    return model


def to_game(point):
    x, y, z = point
    return [round(value, 5) for value in (-x, z, y)]


def export_part(obj, pivot):
    mesh = obj.data
    mesh.calc_loop_triangles()
    offset = Vector(pivot)
    positions = [c for vertex in mesh.vertices for c in to_game(vertex.co - offset)]
    colors = [round(color, 6) for entry in mesh.color_attributes["Paint"].data for color in entry.color[:3]]
    indices = [index for triangle in mesh.loop_triangles for index in triangle.vertices]

    def attribute(array):
        return {"itemSize": 3, "type": "Float32Array", "array": array}

    return {"name": obj.name, "origin": to_game(pivot), "data": {
        "attributes": {"position": attribute(positions), "color": attribute(colors)},
        "index": {"type": "Uint16Array", "array": indices},
    }}


def build_mesh(name, part):
    vertices, faces, colors = part
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    color_layer = mesh.color_attributes.new(name="Paint", type="FLOAT_COLOR", domain="POINT")
    color_layer.data.foreach_set("color", [c for rgb in colors for c in (*rgb, 1.0)])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def preview(army):
    paint = bpy.data.materials.new("Unit paint")
    paint.use_nodes = True
    paint_nodes = paint.node_tree.nodes
    vertex_color = paint_nodes.new("ShaderNodeVertexColor")
    vertex_color.layer_name = "Paint"
    shader = paint_nodes["Principled BSDF"]
    shader.inputs["Roughness"].default_value = 0.78
    paint.node_tree.links.new(vertex_color.outputs["Color"], shader.inputs["Base Color"])
    light_paint = paint.copy()
    light_nodes = light_paint.node_tree.nodes
    light_shader = light_nodes["Principled BSDF"]
    light_paint.node_tree.links.new(light_nodes[vertex_color.name].outputs["Color"], light_shader.inputs["Emission Color"])
    light_shader.inputs["Emission Strength"].default_value = 0.44
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (1, 1, 1, 1)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.43
    scene.view_settings.view_transform = "AgX"
    ground = bpy.data.materials.new("Preview ground")
    ground.use_nodes = True
    terrain = ground.node_tree.nodes["Principled BSDF"]
    terrain.inputs["Base Color"].default_value = (0.059, 0.084, 0.105, 1)
    terrain.inputs["Roughness"].default_value = 1
    bpy.ops.mesh.primitive_plane_add(size=200)
    bpy.context.object.data.materials.append(ground)

    direction = Vector((-0.38, 0.57, 0.77))
    rotation = (-direction).to_track_quat("-Z", "Y")
    right = rotation @ Vector((1, 0, 0))
    back = Vector((-direction.x, -direction.y, 0)).normalized()
    order = ["rover", "scout", "pathfinder", "drone", "infantry", "sentinel",
             "skirmisher", "vanguard", "siege", "reptile", "ancient"]
    for index, name in enumerate(order):
        center = right * ((index % 4 - 1.5) * 3.05) + back * ((1 - index // 4) * 3.62)
        for part, obj in army[name].items():
            obj.location = center
            obj.scale = (1.38, 1.38, 1.38) if name in ("vanguard", "siege") else (1, 1, 1)
            obj.data.materials.append(light_paint if part in ("lights", "turretLights") else paint)
        caption = bpy.data.curves.new(name, "FONT")
        caption.body = name.upper()
        caption.align_x = "CENTER"
        caption.size = 0.205
        label = bpy.data.objects.new(name + " label", caption)
        bpy.context.collection.objects.link(label)
        label.location = center - back * 1.35 + Vector((0, 0, 0.07))
        label.rotation_euler = rotation.to_euler()
    bpy.ops.object.light_add(type="SUN", rotation=(0.50, -0.63, -0.38))
    bpy.context.object.data.energy = 2.65
    bpy.context.object.data.angle = 0.20
    bpy.ops.object.camera_add(location=direction * 20 + Vector((0, 0, 0.50)))
    camera = bpy.context.object
    camera.rotation_euler = rotation.to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 13.6
    scene.camera = camera
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 920
    scene.render.resolution_percentage = 100
    scene.render.filepath = str(ROOT / ".units-preview.png")
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    models = {
        "rover": rover(), "scout": speeder(False), "pathfinder": speeder(True), "drone": survey_drone(),
        "infantry": soldier(False), "sentinel": soldier(True), "skirmisher": armor("skirmisher"),
        "vanguard": armor("vanguard"), "siege": armor("siege"),
        "reptile": reptile(False), "ancient": reptile(True),
    }
    army = {name: {part: build_mesh(part, mesh) for part, mesh in model.parts.items()}
            for name, model in models.items()}
    assets = ROOT / "assets" / "models"
    assets.mkdir(parents=True, exist_ok=True)
    exported = {name: [export_part(obj, models[name].pivots.get(part, (0, 0, 0)))
                       | {"name": part} for part, obj in parts.items()] for name, parts in army.items()}
    (assets / "units.json").write_text(json.dumps(exported, separators=(",", ":")), encoding="utf-8")
    if "--preview" in sys.argv:
        preview(army)
