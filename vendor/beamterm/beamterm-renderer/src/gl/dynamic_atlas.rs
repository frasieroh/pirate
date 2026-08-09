use beamterm_core::gl::{GlyphRasterizer, RasterizedGlyph};
use beamterm_data::{CellSize, FontAtlasData, FontStyle, LineDecoration};

use super::canvas_rasterizer::{CanvasRasterizer, LineHeightLayout};
use crate::error::Error;

// ADDED BY PIRATE. Upstream states the decoration position as a fraction of the
// whole cell height. With a line height multiplier the cell is taller than the
// glyph box, and the raw fraction moves the line away from the glyph. This maps
// the fraction from the glyph box onto the taller cell. The device pixel offset
// from the top of the glyph box then stays the same at every multiplier.
/// Rescales a line decoration from the glyph box to the full cell.
fn scale_line_decoration(
    layout: LineHeightLayout,
    position: f32,
    thickness: f32,
) -> LineDecoration {
    if layout.cell_height == 0 {
        return LineDecoration::new(position, thickness);
    }

    let glyph_height = layout.glyph_height as f32;
    let cell_height = layout.cell_height as f32;
    let offset_from_cell_top = layout.pad_top as f32 + position * glyph_height;

    LineDecoration::new(
        offset_from_cell_top / cell_height,
        thickness * glyph_height / cell_height,
    )
}

/// Canvas-based glyph rasterizer for WASM/browser environments.
///
/// Wraps [`CanvasRasterizer`] to implement [`GlyphRasterizer`] for use with
/// [`DynamicFontAtlas`](beamterm_core::gl::DynamicFontAtlas).
pub(crate) struct CanvasGlyphRasterizer {
    inner: CanvasRasterizer,
    cell_size: CellSize,
    // ADDED BY PIRATE. `update_font_size` builds a new rasterizer. The
    // multiplier must survive that call.
    line_height: f32,
}

impl CanvasGlyphRasterizer {
    pub(crate) fn new(font_family: &str, font_size: f32, line_height: f32) -> Result<Self, Error> {
        let inner = CanvasRasterizer::new(font_family, font_size, line_height)?;
        let cell_size = Self::measure_cell_size(&inner)?;
        Ok(Self { inner, cell_size, line_height })
    }

    fn measure_cell_size(rasterizer: &CanvasRasterizer) -> Result<CellSize, Error> {
        let reference_glyphs = rasterizer.rasterize(&[("\u{2588}", FontStyle::Normal)])?;

        if let Some(g) = reference_glyphs.first() {
            Ok(CellSize::new(
                g.width as i32 - FontAtlasData::PADDING * 2,
                g.height as i32 - FontAtlasData::PADDING * 2,
            ))
        } else {
            Err(Error::rasterizer_empty_reference_glyph())
        }
    }
}

impl GlyphRasterizer for CanvasGlyphRasterizer {
    fn rasterize_batch(
        &mut self,
        glyphs: &[(&str, FontStyle)],
    ) -> Result<Vec<RasterizedGlyph>, beamterm_core::Error> {
        self.inner
            .rasterize(glyphs)
            .map_err(|e| beamterm_core::Error::Resource(e.to_string()))
    }

    fn max_batch_size(&self) -> usize {
        self.inner.max_batch_size()
    }

    fn cell_size(&self) -> CellSize {
        self.cell_size
    }

    fn is_double_width(&mut self, _grapheme: &str) -> bool {
        false // Canvas API doesn't expose font advance metrics
    }

    fn underline(&self) -> LineDecoration {
        // near bottom, thin. ADDED BY PIRATE: rescaled to the taller cell.
        scale_line_decoration(self.inner.line_height_layout(), 0.9, 0.05)
    }

    fn strikethrough(&self) -> LineDecoration {
        // middle, thin. ADDED BY PIRATE: rescaled to the taller cell.
        scale_line_decoration(self.inner.line_height_layout(), 0.5, 0.05)
    }

    fn update_font_size(&mut self, font_size: f32) -> Result<(), beamterm_core::Error> {
        self.inner = CanvasRasterizer::new(self.inner.font_family(), font_size, self.line_height)
            .map_err(|e| beamterm_core::Error::Resource(e.to_string()))?;
        self.cell_size = Self::measure_cell_size(&self.inner)
            .map_err(|e| beamterm_core::Error::Resource(e.to_string()))?;
        Ok(())
    }
}

/// Type alias for the WASM dynamic font atlas.
pub(crate) type DynamicFontAtlas = beamterm_core::gl::DynamicFontAtlas<CanvasGlyphRasterizer>;

// ADDED BY PIRATE. Tests for the line decoration rescale.
#[cfg(test)]
mod tests {
    use super::{super::canvas_rasterizer::line_height_layout, *};

    /// Returns the offset of the line from the top of the glyph box, in device pixels.
    fn offset_from_glyph_top(layout: LineHeightLayout, line: LineDecoration) -> f32 {
        line.position() * layout.cell_height as f32 - layout.pad_top as f32
    }

    #[test]
    fn line_height_1_0_keeps_the_upstream_decorations() {
        let layout = line_height_layout(20, 1.0);
        assert_eq!(
            scale_line_decoration(layout, 0.9, 0.05),
            LineDecoration::new(0.9, 0.05)
        );
        assert_eq!(
            scale_line_decoration(layout, 0.5, 0.05),
            LineDecoration::new(0.5, 0.05)
        );
    }

    #[test]
    fn decorations_hold_their_pixel_offset_from_the_glyph_top() {
        let glyph_height = 20u32;
        for (position, thickness) in [(0.9f32, 0.05f32), (0.5, 0.05)] {
            let base = line_height_layout(glyph_height, 1.0);
            let want_offset = position * glyph_height as f32;
            let want_thickness = thickness * glyph_height as f32;

            assert!(
                (offset_from_glyph_top(base, scale_line_decoration(base, position, thickness))
                    - want_offset)
                    .abs()
                    < 0.01
            );

            for step in 1..=20 {
                let multiplier = 1.0 + step as f32 * 0.05;
                let layout = line_height_layout(glyph_height, multiplier);
                let line = scale_line_decoration(layout, position, thickness);

                let offset = offset_from_glyph_top(layout, line);
                assert!(
                    (offset - want_offset).abs() < 0.01,
                    "multiplier {multiplier}: offset {offset}, want {want_offset}"
                );

                let thickness_px = line.thickness() * layout.cell_height as f32;
                assert!(
                    (thickness_px - want_thickness).abs() < 0.01,
                    "multiplier {multiplier}: thickness {thickness_px}, want {want_thickness}"
                );
            }
        }
    }

    #[test]
    fn decorations_stay_inside_the_cell_at_the_largest_multiplier() {
        let layout = line_height_layout(20, 2.0);
        let underline = scale_line_decoration(layout, 0.9, 0.05);
        assert!(underline.position() > 0.0 && underline.position() < 1.0);
    }

    #[test]
    fn a_zero_height_cell_keeps_the_input_decoration() {
        let layout = line_height_layout(0, 1.5);
        assert_eq!(layout.cell_height, 0);
        assert_eq!(
            scale_line_decoration(layout, 0.9, 0.05),
            LineDecoration::new(0.9, 0.05)
        );
    }
}
