// SdfTextLayout.ts — converts a string into glyph rectangles using MSDF font metadata.
// Coordinates are in EM units (1.0 = font's natural size). Multiply by desired fontSize
// when consuming.

export interface FontMetadata {
    info: { face: string; size: number };
    common: { lineHeight: number; base: number; scaleW: number; scaleH: number };
    distanceField: { fieldType: string; distanceRange: number };
    chars: GlyphMeta[];
    kernings: KerningPair[];
}

export interface GlyphMeta {
    id: number;          // unicode codepoint
    x: number;           // atlas pixel x
    y: number;           // atlas pixel y
    width: number;       // glyph rect in atlas
    height: number;
    xoffset: number;     // shift from cursor
    yoffset: number;     // shift from baseline (Y down)
    xadvance: number;    // cursor advance
}

export interface KerningPair {
    first: number;
    second: number;
    amount: number;
}

export interface LaidGlyph {
    char: string;
    code: number;
    // Quad rect in EM units (Y is down, baseline at top of EM box per BMFont convention)
    x: number;
    y: number;
    width: number;
    height: number;
    // Atlas UVs normalized 0..1
    u0: number;
    v0: number;
    u1: number;
    v1: number;
}

export interface LaidText {
    glyphs: LaidGlyph[];
    width: number;       // total advance width in EM
    lineHeight: number;
}

export class SdfTextLayout {
    private metadata: FontMetadata;
    private glyphMap: Map<number, GlyphMeta>;
    private kerningMap: Map<string, number>;

    constructor(metadata: FontMetadata) {
        this.metadata = metadata;
        this.glyphMap = new Map();
        for (const g of metadata.chars) this.glyphMap.set(g.id, g);
        this.kerningMap = new Map();
        for (const k of metadata.kernings) {
            this.kerningMap.set(k.first + "," + k.second, k.amount);
        }
    }

    layout(text: string, scale: number = 1.0): LaidText {
        const emUnit = 1.0 / this.metadata.info.size;
        const s = emUnit * scale;
        const atlasW = this.metadata.common.scaleW;
        const atlasH = this.metadata.common.scaleH;

        // Expand quad by half SDF distance range so outline isn't clipped at quad edges.
        // CLAMP UVs to atlas bounds — edge glyphs at (0,0) would otherwise sample negative
        // UV and wrap to opposite side of atlas (= sampling wrong glyph entirely).
        // 12.09 (CyberFly): our atlas is generated with `-p 8` and `spacing [0,0]`, so each glyph
        // rect ALREADY contains its SDF padding and the rects touch. Expanding the quad by another
        // half distance-range pulled the neighbouring glyph's pixels in and the labels rendered as
        // smudges. The generator's padding is the expansion, so there is nothing to add here.
        const pad = 0;
        const padEm = pad * s;

        const glyphs: LaidGlyph[] = [];
        let cursorX = 0;
        let prevCode = -1;

        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            const g = this.glyphMap.get(code);
            if (!g) {
                cursorX += scale * 0.5;
                prevCode = code;
                continue;
            }

            if (prevCode >= 0) {
                const k = this.kerningMap.get(prevCode + "," + code);
                if (k) cursorX += k * s;
            }

            // Expanded quad rect (geometry) — clamp UVs to valid atlas range
            const ux0 = Math.max(0, g.x - pad);
            const uy0 = Math.max(0, g.y - pad);
            const ux1 = Math.min(atlasW, g.x + g.width + pad);
            const uy1 = Math.min(atlasH, g.y + g.height + pad);

            // Geometry expansion matches the actual UV expansion (clamped)
            const padLeft   = (g.x - ux0) * s;     // atlas-px → EM
            const padRight  = (ux1 - (g.x + g.width)) * s;
            const padTop    = (g.y - uy0) * s;
            const padBottom = (uy1 - (g.y + g.height)) * s;

            const x = cursorX + g.xoffset * s - padLeft;
            const y = g.yoffset * s - padTop;
            const w = g.width * s + padLeft + padRight;
            const h = g.height * s + padTop + padBottom;

            const u0 = ux0 / atlasW;
            const v0 = uy0 / atlasH;
            const u1 = ux1 / atlasW;
            const v1 = uy1 / atlasH;

            glyphs.push({
                char: text[i],
                code,
                x, y, width: w, height: h,
                u0, v0, u1, v1,
            });

            cursorX += g.xadvance * s;
            prevCode = code;
        }

        return {
            glyphs,
            width: cursorX,
            lineHeight: this.metadata.common.lineHeight * s,
        };
    }
}
