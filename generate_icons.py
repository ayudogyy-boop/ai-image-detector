"""Generate simple shield-style icons for the extension using only stdlib."""
import struct, zlib, os

def make_png(width, height, pixels):
    """Create a PNG from RGBA pixel data (list of [R,G,B,A])."""
    raw = b''
    for y in range(height):
        raw += b'\x00'  # filter byte
        raw += bytes(pixels[y * width * 4 : (y + 1) * width * 4])

    def chunk(t, data):
        c = t + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw))
            + chunk(b'IEND', b''))

def gen_icon(size, color_hex, accent_hex):
    """Generate icon: outer circle with inner checkmark shape."""
    r1, g1, b1 = int(color_hex[0:2], 16), int(color_hex[2:4], 16), int(color_hex[4:6], 16)
    r2, g2, b2 = int(accent_hex[0:2], 16), int(accent_hex[2:4], 16), int(accent_hex[4:6], 16)
    cx = cy = size // 2
    outer_r = size // 2 - 1
    inner_r = size // 3
    pixels = []
    for y in range(size):
        for x in range(size):
            dx, dy = x - cx, y - cy
            dist = (dx*dx + dy*dy) ** 0.5
            if dist > outer_r:
                pixels.extend([0, 0, 0, 0])
            elif dist <= inner_r:
                # inner circle = accent color
                t = dist / inner_r
                rr = int(r1 + (r2 - r1) * (1 - t))
                gg = int(g1 + (g2 - g1) * (1 - t))
                bb = int(b1 + (b2 - b1) * (1 - t))
                pixels.extend([rr, gg, bb, 255])
            else:
                # outer ring = base color
                t = (dist - inner_r) / (outer_r - inner_r)
                rr = int(r1 * (1 - t * 0.3))
                gg = int(g1 * (1 - t * 0.3))
                bb = int(b1 * (1 - t * 0.3))
                pixels.extend([max(0, rr), max(0, gg), max(0, bb), 255])
    return make_png(size, size, pixels)

icons_dir = os.path.join(os.path.dirname(__file__), 'icons')
os.makedirs(icons_dir, exist_ok=True)

icons = [
    (16,  '2563EB', '3B82F6'),   # blue
    (32,  '2563EB', '3B82F6'),
    (48,  '2563EB', '3B82F6'),
    (128, '1D4ED8', '3B82F6'),
]
for size, base, accent in icons:
    data = gen_icon(size, base, accent)
    path = os.path.join(icons_dir, f'icon{size}.png')
    with open(path, 'wb') as f:
        f.write(data)
    print(f'Created {path} ({len(data)} bytes)')
