// VisionHash - the tracked world mesh as the fly-eye cameras see it (vision layer only, after the
// intro scan). Room colours live in a 256x256 "voxel hash" texture baked by WorldColorBake: the
// 8 cm voxel (ix, iy, iz) of a world position maps to texel
//   u = mod(ix, 64) + 64 * mod(iz, 4),  v = mod(iy, 32) + 32 * mod(floor(iz / 4), 8)
// (periods 5.1 x 2.6 x 2.6 m; every intermediate stays < 256 so it is exact even in FP16 on device).
// Alpha = baked; unbaked texels show neutral grey. A faint world-space block pattern (+-blocky)
// keeps optic flow trackable on flat colours. The world mesh sits at the origin with an identity
// transform, so object space == world space. ASCII only.

input_texture_2d colors;
input_float gain = 1.0;
input_float blocky = 0.25;
input_float voxel = 8.0;

output_vec4 vertexColor;

float hash3(vec3 p) {
    // 12.09 shader audit: `+ 33.33` pushed the intermediate to ~2e4, where mediump steps by ~16 and
    // `fract` returns bands instead of noise. Same hash, kept under ~500 (see RoomPaint).
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 3.33);
    return fract((p.x + p.y) * p.z * 7.0);
}

void main() {
    vec3 wp = system.getSurfacePositionObjectSpace();
    float vs = voxel;
    if (vs < 1.0) vs = 1.0;
    vec3 iv = floor(wp / vs);
    float u = mod(iv.x, 64.0) + 64.0 * mod(iv.z, 4.0);
    float v = mod(iv.y, 32.0) + 32.0 * mod(floor(iv.z / 4.0), 8.0);
    vec4 c = colors.sample(vec2((u + 0.5) / 256.0, (v + 0.5) / 256.0));
    vec3 col = mix(vec3(0.35, 0.35, 0.35), c.rgb, c.a);
    float blocks = hash3(iv * 0.5 + 5.0) * 2.0 - 1.0;
    vertexColor = vec4(col * gain * (1.0 + blocky * blocks), 1.0);
}
