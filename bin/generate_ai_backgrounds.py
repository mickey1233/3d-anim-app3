#!/usr/bin/env python3
from PIL import Image, ImageDraw, ImageFilter
import os

WIDTH = 1024
HEIGHT = 512

OUT_DIR = os.path.join('public', 'v2', 'backgrounds_ai')
os.makedirs(OUT_DIR, exist_ok=True)


def gradient(size, top, bottom):
    w, h = size
    img = Image.new('RGB', (w, h), bottom)
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / (h - 1)
        r = int(top[0] * (1 - t) + bottom[0] * t)
        g = int(top[1] * (1 - t) + bottom[1] * t)
        b = int(top[2] * (1 - t) + bottom[2] * t)
        draw.line([(0, y), (w, y)], fill=(r, g, b))
    return img


def add_horizon(img, color, height_ratio=0.55):
    draw = ImageDraw.Draw(img)
    y = int(img.size[1] * height_ratio)
    draw.rectangle([0, y, img.size[0], img.size[1]], fill=color)


def add_skyline(img, base_y, color, seed=1):
    import random
    random.seed(seed)
    draw = ImageDraw.Draw(img)
    w, h = img.size
    x = 0
    while x < w:
        bw = random.randint(30, 90)
        bh = random.randint(60, 200)
        draw.rectangle([x, base_y - bh, x + bw, base_y], fill=color)
        x += bw + random.randint(8, 20)


def add_columns(img, base_y, color, count=6):
    draw = ImageDraw.Draw(img)
    w, h = img.size
    spacing = w // count
    for i in range(count):
        x = i * spacing + spacing // 4
        draw.rectangle([x, base_y - 220, x + 28, base_y], fill=color)


def add_warehouse(img):
    add_horizon(img, (120, 110, 100), 0.62)
    draw = ImageDraw.Draw(img)
    w, h = img.size
    # beams
    for x in range(40, w, 120):
        draw.rectangle([x, int(h*0.2), x+14, int(h*0.62)], fill=(90, 80, 70))
    # shelves
    for y in range(int(h*0.35), int(h*0.6), 30):
        draw.rectangle([0, y, w, y+6], fill=(110, 100, 90))


def add_studio(img):
    draw = ImageDraw.Draw(img)
    w, h = img.size
    # soft light panels
    for i in range(3):
        x0 = 120 + i * 240
        draw.rounded_rectangle([x0, int(h*0.2), x0+160, int(h*0.35)], radius=20, fill=(220, 220, 220))


def add_forest(img):
    add_horizon(img, (45, 85, 55), 0.6)
    draw = ImageDraw.Draw(img)
    w, h = img.size
    for x in range(20, w, 40):
        draw.polygon([(x, int(h*0.6)), (x+20, int(h*0.35)), (x+40, int(h*0.6))], fill=(30, 70, 40))


def add_apartment(img):
    add_horizon(img, (150, 130, 120), 0.65)
    draw = ImageDraw.Draw(img)
    w, h = img.size
    # window frames
    for x in range(80, w, 140):
        draw.rectangle([x, int(h*0.25), x+90, int(h*0.5)], outline=(200, 200, 200), width=3)


def add_lobby(img):
    add_horizon(img, (140, 120, 105), 0.6)
    add_columns(img, int(img.size[1]*0.6), (95, 85, 75), 7)


def add_park(img):
    add_horizon(img, (90, 130, 80), 0.65)
    draw = ImageDraw.Draw(img)
    w, h = img.size
    draw.ellipse([int(w*0.15), int(h*0.5), int(w*0.35), int(h*0.7)], fill=(70, 120, 60))
    draw.ellipse([int(w*0.55), int(h*0.55), int(w*0.8), int(h*0.8)], fill=(60, 110, 55))


def generate(env):
    if env == 'city':
        img = gradient((WIDTH, HEIGHT), (80, 110, 140), (200, 200, 210))
        add_horizon(img, (180, 180, 185), 0.65)
        add_skyline(img, int(HEIGHT*0.65), (70, 80, 90), seed=3)
    elif env == 'warehouse':
        img = gradient((WIDTH, HEIGHT), (120, 130, 140), (210, 200, 190))
        add_warehouse(img)
    elif env == 'studio':
        img = gradient((WIDTH, HEIGHT), (140, 150, 160), (210, 210, 215))
        add_studio(img)
    elif env == 'sunset':
        img = gradient((WIDTH, HEIGHT), (255, 150, 90), (80, 40, 80))
    elif env == 'dawn':
        img = gradient((WIDTH, HEIGHT), (180, 210, 240), (255, 190, 160))
    elif env == 'night':
        img = gradient((WIDTH, HEIGHT), (20, 25, 40), (70, 60, 90))
    elif env == 'forest':
        img = gradient((WIDTH, HEIGHT), (90, 130, 100), (40, 60, 45))
        add_forest(img)
    elif env == 'apartment':
        img = gradient((WIDTH, HEIGHT), (170, 170, 180), (220, 210, 200))
        add_apartment(img)
    elif env == 'lobby':
        img = gradient((WIDTH, HEIGHT), (150, 150, 155), (200, 190, 175))
        add_lobby(img)
    elif env == 'park':
        img = gradient((WIDTH, HEIGHT), (110, 160, 170), (180, 200, 160))
        add_park(img)
    else:
        img = gradient((WIDTH, HEIGHT), (120, 120, 120), (200, 200, 200))

    img = img.filter(ImageFilter.GaussianBlur(radius=0.6))
    return img


if __name__ == '__main__':
    envs = ['warehouse', 'studio', 'city', 'sunset', 'dawn', 'night', 'forest', 'apartment', 'lobby', 'park']
    for env in envs:
        img = generate(env)
        out_path = os.path.join(OUT_DIR, f'{env}.jpg')
        img.save(out_path, quality=88)
        print('wrote', out_path)
