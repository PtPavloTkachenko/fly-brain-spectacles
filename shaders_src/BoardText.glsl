// BoardText - all the board's text of one font in ONE mesh, one draw call.
// Batched MSDF text: one mesh for every label on the board.
//
// Atlas channels (see tools/text/build_atlas.py):
//   atlas.rgb = MSDF, 3-channel median -> a sharp glyph body at any size
//   atlas.a   = plain SDF             -> a rounded outline, so text stays readable on the room
//
// UV channels (LS specific): index 0 is the engine's own auto UV and cannot be written, so the
// mesh's atlas UV lives in "texture1" = getSurfaceUVCoord1(). Lens Studio flips V on PNG import.
// ASCII only, no input named `color` (the Spectacles cross-compiler rejects it).

input_texture_2d atlas;
input_color4 tint = vec4(0.86, 0.95, 1.0, 1.0);
input_color4 outlineColor = vec4(0.0, 0.0, 0.0, 1.0);
input_float outlineSize = 0.0;
input_float gain = 1.0;

output_vec4 vertexColor;

void main() {
    vec2 uv = system.getSurfaceUVCoord1();
    uv.y = 1.0 - uv.y;
    // per-vertex colour (uv2 = r,g and uv3 = b,a): one batch can hold captions, labels and the
    // Gemini section in their own colours and still be ONE draw call
    vec2 c01 = system.getSurfaceUVCoord2();
    vec2 c23 = system.getSurfaceUVCoord3();
    vec4 vcol = vec4(c01.x, c01.y, c23.x, c23.y);
    vec4 s = atlas.sample(uv);

    vec3 msd = s.rgb;
    float fill = max(min(msd.r, msd.g), min(max(msd.r, msd.g), msd.b));

    // adaptive antialiasing: crisp whether the board is at arm's length or across the room
    float fillAA = max(fwidth(fill), 0.001);
    float fillEdge = smoothstep(0.5 - fillAA, 0.5 + fillAA, fill);

    // 12.09 shader audit: the outline is always off on an additive display (an outline could only
    // ADD dark pixels), so its SDF path - a second fwidth, a second smoothstep and the alpha
    // channel fetch - was paid on every glyph pixel for nothing. The A channel of the atlas stays
    // in the file; turn outlineSize up and this comes back with one line.
    vec4 c = vec4(tint.r * vcol.r, tint.g * vcol.g, tint.b * vcol.b, tint.a * vcol.a * fillEdge * gain);
    vertexColor = c;
}
