// EyeMosaic - the board's compound-eye panel (ADR 54). One quad per map, three maps per eye.
//
// The texture is the eye map itself: one texel per ommatidial column, on the MaleCNS lattice in
// OFFSET coordinates (row = hex2, column = hex1 - (hex2 - hex2&1)/2). That conversion is the whole
// point: hex1/hex2 are AXIAL, and plotting them on a square grid shears the eye ~30 degrees. In
// offset coordinates the footprint is a clean 30 x 39 oval, the same on both sides.
//
// MODE rides in tint.a, because this graph has five inputs and a sixth means surgery on the node
// YAML:  0 = IMAGE (the picture the ommatidia sample), 1 = ON, 2 = OFF.
//   IMAGE texture: rgb = what that column sees, a = a column lives here
//   ON/OFF texture: r = ON, g = OFF, b = a column lives here
// `cells` carries both axes packed as columns + rows/100 (30.39). Odd rows are offset half a cell,
// so the grid is a real hex packing, and the lens is squashed by the hex row spacing (0.866) so
// every ommatidium is round on screen.
//
// Alpha out is 1.0 on purpose: this is an additive pass, so brightness must ride in rgb alone. An
// earlier version carried it in alpha too and the panel multiplied itself away to nothing (15.09).
// sqrt() on ON/OFF is a DISPLAY gamma - the brain still gets the linear bytes.
// ASCII only; no input named `color` (the Spectacles cross-compiler rejects it).

input_texture_2d eye;
input_color4 tint;
input_float gain;
input_float grid;
input_float cells;

output_vec4 vertexColor;

void main() {
    vec2 uv = system.getSurfaceUVCoord0();
    uv.y = 1.0 - uv.y; // LS flips V on import; the lattice's first row is the bottom of the eye

    float cols = floor(cells);
    if (cols < 2.0) cols = 2.0;
    float rows = floor(fract(cells) * 100.0 + 0.5);
    if (rows < 2.0) rows = cols;

    float ry = uv.y * rows;
    float row = floor(ry);
    float shift = mod(row, 2.0) * 0.5; // hex packing: odd rows half a cell across
    float rx = uv.x * cols + shift;
    float col = floor(rx);

    vec4 s = eye.sample(vec2((col + 0.5) / cols, (row + 0.5) / rows));

    // round lens: the cell is 1/cols wide and 1/rows tall, and hex rows sit 0.866 apart
    vec2 f = vec2(fract(rx), fract(ry)) - 0.5;
    float d = length(f * vec2(1.0, 0.866));
    float lens = 1.0 - smoothstep(0.30, 0.47, d);

    float mode = floor(tint.a * 10.0 + 0.5);

    vec3 rgb;
    if (mode < 0.5) {
        // IMAGE: the picture the ommatidia sample. A touch of the fly's colour keeps it on the
        // board's palette without hiding what the room actually looks like.
        float here = s.a;
        vec3 seen = s.rgb * mix(vec3(1.0), tint.rgb, 0.35);
        rgb = seen * here;
    } else {
        // ON or OFF, on a dim lattice so the oval stays readable when the eye is still
        float here = s.b;
        float v = sqrt(mode < 1.5 ? s.r : s.g);
        vec3 lit = mode < 1.5 ? vec3(1.0, 0.70, 0.28) : vec3(0.32, 0.86, 1.0);
        float seed = fract(sin(col * 12.9898 + row * 78.233) * 43758.5453);
        float ph = fract(system.getTimeElapsed() * 0.13 + seed);
        float breath = 0.62 + 0.38 * sin(ph * 6.2831853);
        rgb = tint.rgb * grid * breath * here + lit * v;
    }
    vertexColor = vec4(rgb * gain * lens, 1.0);
}
