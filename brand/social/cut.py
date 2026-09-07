"""Cut the triptych strip into three 1080x1350 tiles with a 40px overlap.

Instagram lays the three posts side by side in the profile grid with a
hairline gutter between them. A clean 1/3 split puts content right on that
gutter; overlapping the windows by 40px means each tile carries a sliver of
its neighbour, so the seam reads as continuous instead of cut.
"""
from PIL import Image

TILE, OVERLAP = 1080, 40
src = Image.open('_strip.png')
W, H = src.size
expect = TILE * 3 - OVERLAP * 2
assert (W, H) == (expect, 1350), f'strip is {src.size}, expected {(expect, 1350)}'

for i in range(3):
    x = i * (TILE - OVERLAP)
    src.crop((x, 0, x + TILE, H)).save(f'sendoff-pin-{i+1}-of-3.png')
    print(f'pin {i+1}: x {x}..{x+TILE}')

# A contact sheet that shows how the three read in a grid, gutters included.
GUT = 12
sheet = Image.new('RGB', (TILE * 3 + GUT * 2, H), (10, 12, 14))
for i in range(3):
    sheet.paste(Image.open(f'sendoff-pin-{i+1}-of-3.png'), (i * (TILE + GUT), 0))
sheet.save('_pin-sheet.png')
print('sheet', sheet.size)
