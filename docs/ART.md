# Generated art assets

These original raster assets were generated with the built-in `image_gen` tool in its default built-in mode. No API or CLI fallback was used. They are intended for the current project and copied into its public texture directory.

## Terrain atlas

- File: `public/textures/terrain-atlas.png`
- Requested dimensions: 1536 × 1024 pixels
- Delivered dimensions: 1536 × 1024 pixels
- Grid: 3 equal columns × 2 equal rows, with no gutters
- Top row: forest floor, grass meadow, harvested wheat
- Bottom row: red clay, granite rock, dune sand
- Purpose: diffuse/albedo maps for the six terrain types on the 3D hex board

### Final generation prompt

```text
Use case: photorealistic-natural.
Asset type: terrain albedo texture atlas for the surfaces of a realistic medieval 3D Catan board.
Generate a 1536 x 1024 pixel image. EXACT layout of THREE EQUAL COLUMNS and TWO EQUAL ROWS: six 512 x 512 square panels. No gutters, borders, outlines, labels, or spaces. Each panel fills edge to edge and each adjoining panel meets at a perfectly straight edge. The six panels must be positioned precisely:
TOP LEFT: damp dark pine forest floor, moss, pine needles, small leaf litter, rich dark forest soil.
TOP CENTER: lush natural grass meadow, fine dense grass, clover and subtle earthy details.
TOP RIGHT: harvested ripe wheat stubble, golden stalks with alternating narrow plowed earth rows.
BOTTOM LEFT: rusty red clay and quarried red rock, angular small fragments and terracotta colored earth.
BOTTOM CENTER: weathered gray granite rock surface, mottled cracks and coarse mineral grain.
BOTTOM RIGHT: fine warm beige dune sand with subtle natural ripples.
Style: highly detailed photorealistic natural materials, diffuse even lighting. Camera is perfectly orthographic, flat straight down. This is a texture sheet, not a scene. Natural subtle variation at macro scale. No directional cast shadows, no perspective, no horizon, no trees seen from the side, no objects, buildings, icons, text, symbols, or watermarks. Exact equal panel grid is essential for direct UV mapping.
```

## Parchment

- File: `public/textures/parchment.png`
- Requested dimensions: 1024 × 1024 pixels
- Delivered dimensions: 1254 × 1254 pixels; the original generated resolution is preserved
- Purpose: subdued antique paper background for game interface panels

### Final generation prompt

```text
Use case: photorealistic-natural.
Asset type: antique parchment material background for a medieval game interface with overlaid readable text.
Generate a 1024 x 1024 pixel square high detail photorealistic scan of antique Renaissance rag parchment. Warm cream and muted golden brown paper fibers, subtle foxing, heavily worn aged edges, restrained old creases, and a broad plain readable center with gentle paper grain. Flat, full frame, straight down orthographic scanned material. The entire image is filled with parchment, edge to edge. Even diffuse light with no shadows or perspective.
Constraints: absolutely no writing, letters, numbers, text, logos, stamps, maps, decorations, symbols, illustrations, or watermark. The center must remain pale, quiet, and readable as an interface background. Rich tactile realistic fibers and patina rather than an illustration.
```

## Inspection

Both files were visually inspected after generation and copied without alteration. The terrain atlas has the required six materials, equal grid, correct ordering, no gutters, and no text. The parchment has a quiet pale center, worn darker edges, and no text or decoration. File dimensions were verified with `sips`.
