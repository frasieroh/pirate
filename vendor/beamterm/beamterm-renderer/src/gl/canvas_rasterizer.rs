//! Canvas-based glyph rasterizer for dynamic font atlas generation.
//!
//! Uses the browser's native text rendering via OffscreenCanvas to rasterize
//! glyphs on demand. This approach handles:
//! - Color emoji (COLR/CBDT/SVG fonts)
//! - Complex emoji sequences (ZWJ, skin tones)
//! - CJK and other fullwidth characters
//! - Ligatures (when supported by the font)
//! - Font fallback chains (handled by browser)
//! - Per-glyph font styles (normal, bold, italic, bold-italic)
//!
//! # Example
//!
//! ```ignore
//! use beamterm_data::FontStyle;
//!
//! let rasterizer = CanvasRasterizer::new("'JetBrains Mono', monospace", 16.0)?;
//!
//! // Batch rasterize glyphs with per-glyph styles
//! let glyphs = rasterizer.rasterize(&[
//!     ("A", FontStyle::Normal),
//!     ("B", FontStyle::Bold),
//!     ("C", FontStyle::Italic),
//!     ("🚀", FontStyle::Normal),  // emoji always uses Normal
//! ])?;
//!
//! // Double-width glyphs (emoji, CJK) have width = cell_width * 2
//! for glyph in &glyphs {
//!     println!("{}x{}", glyph.width, glyph.height);
//! }
//! ```

use beamterm_data::{FontAtlasData, FontStyle};
use compact_str::CompactString;
use wasm_bindgen::prelude::*;
use web_sys::{OffscreenCanvas, OffscreenCanvasRenderingContext2d};

use crate::error::Error;

// padding around glyphs matches StaticFontAtlas to unify texture packing.
const PADDING: u32 = FontAtlasData::PADDING as u32;

const OFFSCREEN_CANVAS_WIDTH: u32 = 256;

/// Number of glyphs per rasterization batch.
/// Canvas height is scaled to fit this many glyphs.
const GLYPH_BATCH_SIZE: usize = 32;

// ADDED BY PIRATE. Upstream takes the ink box of the reference glyph as the
// cell, and it gives no way to make the cell taller. pirate needs a line height
// setting. The extra pixels go into the rasterized bitmap, not into the quad.
// The fragment shader samples the glyph across the full quad, so a taller quad
// with an unchanged bitmap stretches the glyph.
/// Smallest line height multiplier.
pub(super) const LINE_HEIGHT_MIN: f32 = 1.0;
/// Largest line height multiplier.
pub(super) const LINE_HEIGHT_MAX: f32 = 2.0;

// ADDED BY PIRATE. The arithmetic is in a free function, and a host test calls
// it. The rest of this module needs a browser.
/// Vertical layout of one cell after the line height multiplier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct LineHeightLayout {
    /// Ink height of the reference glyph, in device pixels.
    pub(super) glyph_height: u32,
    /// Cell height after the multiplier, in device pixels.
    pub(super) cell_height: u32,
    /// Device pixels added above the glyph box.
    pub(super) pad_top: u32,
    /// Device pixels added below the glyph box.
    pub(super) pad_bottom: u32,
}

/// Computes the vertical layout of one cell for a line height multiplier.
///
/// The multiplier clamps to the range `LINE_HEIGHT_MIN` to `LINE_HEIGHT_MAX`.
/// A NaN multiplier gives the same layout as `LINE_HEIGHT_MIN`. The extra
/// height splits above and below the glyph. When the extra height is an odd
/// number of device pixels, the top gets the larger half.
pub(super) fn line_height_layout(glyph_height: u32, line_height: f32) -> LineHeightLayout {
    let multiplier = line_height.clamp(LINE_HEIGHT_MIN, LINE_HEIGHT_MAX);

    // `as u32` saturates. NaN gives 0, and `max` then gives the glyph height.
    let scaled = (glyph_height as f32 * multiplier).round() as u32;
    let cell_height = scaled.max(glyph_height);

    let extra = cell_height - glyph_height;
    let pad_top = extra.div_ceil(2);

    LineHeightLayout {
        glyph_height,
        cell_height,
        pad_top,
        pad_bottom: extra - pad_top,
    }
}

/// Cell metrics for positioning glyphs correctly.
#[derive(Debug, Clone, Copy)]
pub(super) struct CellMetrics {
    padded_width: u32,
    /// How far above the baseline the glyph extends (for positioning with baseline "top")
    ascent: f64,
    // ADDED BY PIRATE. The cell height comes from this layout. Upstream stored
    // `padded_height` here, and `padded_height()` now derives it.
    line_height: LineHeightLayout,
}

impl CellMetrics {
    // ADDED BY PIRATE. Replaces the upstream `padded_height` field.
    /// Returns the cell height with the padding, in device pixels.
    fn padded_height(&self) -> u32 {
        self.line_height.cell_height + 2 * PADDING
    }
}

/// Re-export core's RasterizedGlyph for use within the renderer.
pub(crate) use beamterm_core::gl::RasterizedGlyph;

/// Canvas-based glyph rasterizer using OffscreenCanvas.
///
/// This rasterizer leverages the browser's native text rendering capabilities
/// to handle complex Unicode rendering including emoji and fullwidth characters.
pub(crate) struct CanvasRasterizer {
    canvas: OffscreenCanvas,
    render_ctx: OffscreenCanvasRenderingContext2d,
    font_family: CompactString,
    font_size: f32,
    cell_metrics: CellMetrics,
}

impl CanvasRasterizer {
    /// Creates a new canvas rasterizer with the specified cell dimensions.
    ///
    /// `line_height` is a multiplier of the measured cell height. It clamps to
    /// the range `LINE_HEIGHT_MIN` to `LINE_HEIGHT_MAX`.
    ///
    /// # Returns
    ///
    /// A configured rasterizer context, or an error if canvas creation fails.
    pub(crate) fn new(font_family: &str, font_size: f32, line_height: f32) -> Result<Self, Error> {
        // Create canvas with minimal height for initial measurement
        let canvas = OffscreenCanvas::new(OFFSCREEN_CANVAS_WIDTH, 128)
            .map_err(|e| Error::rasterizer_canvas_creation_failed(js_error_string(&e)))?;

        let ctx = canvas
            .get_context("2d")
            .map_err(|e| Error::rasterizer_canvas_creation_failed(js_error_string(&e)))?
            .ok_or_else(Error::rasterizer_context_failed)?
            .dyn_into::<OffscreenCanvasRenderingContext2d>()
            .map_err(|_| Error::rasterizer_context_failed())?;

        let font_string = build_font_string(font_family, font_size, FontStyle::Normal);

        ctx.set_text_baseline("top");
        ctx.set_text_align("left");
        ctx.set_font(&font_string);

        let cell_metrics = Self::measure_cell_metrics(&ctx, line_height)?;

        // Resize canvas to fit GLYPH_BATCH_SIZE glyphs
        let required_height = GLYPH_BATCH_SIZE as u32 * cell_metrics.padded_height();
        canvas.set_height(required_height);

        // Re-initialize context after resize (canvas resize clears context state)
        ctx.set_text_baseline("top");
        ctx.set_text_align("left");
        ctx.set_font(&font_string);

        Ok(Self {
            canvas,
            render_ctx: ctx,
            font_family: CompactString::new(font_family),
            font_size,
            cell_metrics,
        })
    }

    /// Returns the maximum number of glyphs that fit in a single rasterization batch.
    ///
    /// The canvas is sized to fit exactly this many glyphs.
    #[allow(clippy::unused_self)] // consistent with GlyphRasterizer trait interface
    pub(crate) fn max_batch_size(&self) -> usize {
        GLYPH_BATCH_SIZE
    }

    /// Rasterizes all glyphs and returns them as a vector.
    ///
    /// Each glyph is paired with its font style. Emoji glyphs always use
    /// `FontStyle::Normal` regardless of the requested style.
    ///
    /// Glyphs are drawn vertically on the canvas (one per row) and extracted
    /// with a single `getImageData()` call for efficiency.
    ///
    /// Double-width glyphs (emoji, CJK) will have `width = cell_width * 2`.
    pub(crate) fn rasterize(
        &self,
        symbols: &[(&str, FontStyle)],
    ) -> Result<Vec<RasterizedGlyph>, Error> {
        if symbols.is_empty() {
            return Ok(Vec::new());
        }

        self.render_ctx.set_fill_style_str("white");

        let base_font = build_font_string(&self.font_family, self.font_size, FontStyle::Normal);
        self.render_ctx.set_font(&base_font);

        let cell_w = self.cell_metrics.padded_width;
        let cell_h = self.cell_metrics.padded_height();

        let num_glyphs = symbols.len() as u32;

        // canvas needs to be double-width (for emoji) and tall enough for all glyphs
        let canvas_width = cell_w * 2;
        let canvas_height = cell_h * num_glyphs;

        self.render_ctx.clear_rect(
            0.0,
            0.0,
            self.canvas.width() as f64,
            self.canvas.height() as f64,
        );

        let mut current_style: Option<FontStyle> = Some(FontStyle::Normal);
        // ADDED BY PIRATE. `pad_top` centers the glyph in the taller cell.
        // It is 0 at a line height of 1.0.
        let y_offset = PADDING as f64
            + self.cell_metrics.ascent
            + self.cell_metrics.line_height.pad_top as f64;

        // draw each glyph on its own row with clipping to prevent bleed
        for (i, &(grapheme, style)) in symbols.iter().enumerate() {
            // emoji always uses normal style (no bold/italic variants)
            let effective_style =
                if beamterm_core::is_emoji(grapheme) { FontStyle::Normal } else { style };

            // update font if style changed
            if current_style != Some(effective_style) {
                let font = build_font_string(&self.font_family, self.font_size, effective_style);
                self.render_ctx.set_font(&font);
                current_style = Some(effective_style);
            }

            let y = (i as u32 * cell_h) as f64;

            // clip to this glyph's cell area to prevent bleeding into adjacent glyphs
            self.render_ctx.save();
            self.render_ctx.begin_path();
            self.render_ctx
                .rect(0.0, y, canvas_width as f64, cell_h as f64);
            self.render_ctx.clip();

            self.render_ctx
                .fill_text(grapheme, PADDING as f64, y + y_offset)
                .map_err(|e| Error::rasterizer_fill_text_failed(grapheme, js_error_string(&e)))?;

            self.render_ctx.restore();
        }

        // extract all pixels at once
        let image_data = self
            .render_ctx
            .get_image_data(0.0, 0.0, canvas_width as f64, canvas_height as f64)
            .map_err(|e| Error::rasterizer_get_image_data_failed(js_error_string(&e)))?;
        let all_pixels = image_data.data().to_vec();

        // split into individual glyphs
        let bytes_per_pixel = 4usize;
        let row_stride = canvas_width as usize * bytes_per_pixel;
        let glyph_stride = cell_h as usize * row_stride;

        let mut results = Vec::with_capacity(symbols.len());

        for (i, &(grapheme, _)) in symbols.iter().enumerate() {
            let padded_width =
                if beamterm_core::is_double_width(grapheme) { cell_w * 2 } else { cell_w };

            let glyph_start = i * glyph_stride;
            let mut pixels = Vec::with_capacity((padded_width * cell_h) as usize * bytes_per_pixel);

            // extract rows, include padding
            for row in 0..cell_h as usize {
                let row_start = glyph_start + row * row_stride;
                let row_end = row_start + (padded_width as usize * bytes_per_pixel);
                pixels.extend_from_slice(&all_pixels[row_start..row_end]);
            }

            results.push(RasterizedGlyph::new(pixels, padded_width, cell_h));
        }

        Ok(results)
    }

    /// Returns the font family string used by this rasterizer.
    pub(super) fn font_family(&self) -> &str {
        &self.font_family
    }

    // ADDED BY PIRATE. The line decorations need the glyph box inside the cell.
    /// Returns the vertical layout of one cell.
    pub(super) fn line_height_layout(&self) -> LineHeightLayout {
        self.cell_metrics.line_height
    }

    /// Measures cell size by rendering "█" and scanning actual pixel bounds.
    /// This is more accurate than text metrics which can have rounding issues.
    fn measure_cell_metrics(
        render_ctx: &OffscreenCanvasRenderingContext2d,
        line_height: f32,
    ) -> Result<CellMetrics, Error> {
        let buffer_size = 128u32;
        let draw_offset = 16.0; // Draw with offset to capture any negative positioning

        render_ctx.clear_rect(0.0, 0.0, buffer_size as f64, buffer_size as f64);
        render_ctx.set_fill_style_str("white");
        render_ctx
            .fill_text("█", draw_offset, draw_offset)
            .map_err(|e| Error::rasterizer_measure_failed(js_error_string(&e)))?;

        let image_data = render_ctx
            .get_image_data(0.0, 0.0, buffer_size as f64, buffer_size as f64)
            .map_err(|e| Error::rasterizer_measure_failed(js_error_string(&e)))?;

        let pixels = image_data.data();

        // infer good-enough pixel bounds (where alpha > threshold)
        const ALPHA_THRESHOLD: u8 = 128;
        let mut min_x = buffer_size;
        let mut max_x = 0u32;
        let mut min_y = buffer_size;
        let mut max_y = 0u32;

        for y in 0..buffer_size {
            for x in 0..buffer_size {
                let idx = ((y * buffer_size + x) * 4 + 3) as usize; // alpha channel
                if pixels[idx] >= ALPHA_THRESHOLD {
                    min_x = min_x.min(x);
                    max_x = max_x.max(x);
                    min_y = min_y.min(y);
                    max_y = max_y.max(y);
                }
            }
        }

        // no pixels found: the reference glyph didn't render
        if max_x < min_x || max_y < min_y {
            return Err(Error::rasterizer_measure_failed(
                "reference glyph produced no visible pixels".to_string(),
            ));
        }

        // calculate dimensions from pixel bounds
        let width = max_x - min_x + 1;
        let height = max_y - min_y + 1;

        // ascent is how far above the draw position the glyph started
        // (draw_offset - min_y) gives pixels above the draw point
        let ascent = draw_offset - min_y as f64;

        Ok(CellMetrics {
            padded_width: width + 2 * PADDING,
            ascent,
            // ADDED BY PIRATE. `height` is the ink height of the reference glyph.
            line_height: line_height_layout(height, line_height),
        })
    }
}

/// Converts a JsValue error to a displayable string for error messages.
fn js_error_string(err: &JsValue) -> String {
    err.as_string()
        .unwrap_or_else(|| format!("{err:?}"))
}

/// Builds a CSS font string with style modifiers.
fn build_font_string(font_family: &str, font_size: f32, style: FontStyle) -> String {
    let (bold, italic) = match style {
        FontStyle::Normal => (false, false),
        FontStyle::Bold => (true, false),
        FontStyle::Italic => (false, true),
        FontStyle::BoldItalic => (true, true),
    };

    let style_str = if italic { "italic " } else { "" };
    let weight = if bold { "bold " } else { "" };

    format!("{style_str}{weight}{font_size}px {font_family}, monospace")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_font_string() {
        assert_eq!(
            build_font_string("'Hack'", 16.0, FontStyle::Normal),
            "16px 'Hack', monospace"
        );
        assert_eq!(
            build_font_string("'Hack'", 16.0, FontStyle::Bold),
            "bold 16px 'Hack', monospace"
        );
        assert_eq!(
            build_font_string("'Hack'", 16.0, FontStyle::Italic),
            "italic 16px 'Hack', monospace"
        );
        assert_eq!(
            build_font_string("'Hack'", 16.0, FontStyle::BoldItalic),
            "italic bold 16px 'Hack', monospace"
        );
    }

    // ADDED BY PIRATE. Tests for the line height multiplier.

    #[test]
    fn line_height_1_0_keeps_the_upstream_cell() {
        for glyph_height in [1u32, 7, 16, 17, 32, 100] {
            let layout = line_height_layout(glyph_height, 1.0);
            assert_eq!(layout.cell_height, glyph_height);
            assert_eq!(layout.pad_top, 0);
            assert_eq!(layout.pad_bottom, 0);
        }
    }

    #[test]
    fn line_height_splits_an_even_extra_in_half() {
        // 20 * 1.5 = 30. The extra height is 10 device pixels.
        let layout = line_height_layout(20, 1.5);
        assert_eq!(layout.cell_height, 30);
        assert_eq!(layout.pad_top, 5);
        assert_eq!(layout.pad_bottom, 5);
    }

    #[test]
    fn line_height_gives_an_odd_extra_larger_half_to_the_top() {
        // 10 * 1.5 = 15. The extra height is 5 device pixels.
        let layout = line_height_layout(10, 1.5);
        assert_eq!(layout.cell_height, 15);
        assert_eq!(layout.pad_top, 3);
        assert_eq!(layout.pad_bottom, 2);
    }

    #[test]
    fn line_height_padding_always_sums_to_the_extra_height() {
        for glyph_height in 1u32..64 {
            for step in 0..=20 {
                let layout = line_height_layout(glyph_height, 1.0 + step as f32 * 0.05);
                assert_eq!(layout.glyph_height, glyph_height);
                assert_eq!(
                    layout.pad_top + layout.pad_bottom,
                    layout.cell_height - glyph_height
                );
                assert!(layout.pad_top >= layout.pad_bottom);
            }
        }
    }

    /// Returns the offset of the glyph origin from the top of the cell.
    /// This is the `y_offset` of `rasterize`.
    fn glyph_origin_y(metrics: CellMetrics) -> f64 {
        PADDING as f64 + metrics.ascent + metrics.line_height.pad_top as f64
    }

    #[test]
    fn line_height_1_0_keeps_the_upstream_height_and_origin() {
        // Upstream: `padded_height` is `ink_height + 2 * PADDING`, and the
        // glyph origin is `PADDING + ascent`.
        let ink_height = 19u32;
        let ascent = 3.5f64;
        let metrics = CellMetrics {
            padded_width: 11 + 2 * PADDING,
            ascent,
            line_height: line_height_layout(ink_height, 1.0),
        };

        assert_eq!(metrics.padded_height(), ink_height + 2 * PADDING);
        assert_eq!(glyph_origin_y(metrics), PADDING as f64 + ascent);
    }

    #[test]
    fn a_taller_cell_moves_the_glyph_origin_down_by_pad_top() {
        let ink_height = 19u32;
        let ascent = 3.5f64;
        let metrics = CellMetrics {
            padded_width: 11 + 2 * PADDING,
            ascent,
            line_height: line_height_layout(ink_height, 1.5),
        };

        // 19 * 1.5 = 28.5, and that rounds to 29. The extra height is 10.
        assert_eq!(metrics.line_height.cell_height, 29);
        assert_eq!(metrics.line_height.pad_top, 5);
        assert_eq!(metrics.padded_height(), 29 + 2 * PADDING);
        assert_eq!(glyph_origin_y(metrics), PADDING as f64 + ascent + 5.0);

        // `CanvasGlyphRasterizer::measure_cell_size` strips the padding back
        // off. The reported cell then holds the extra height.
        assert_eq!(
            metrics.padded_height() - 2 * PADDING,
            metrics.line_height.cell_height
        );
    }

    #[test]
    fn line_height_clamps_to_the_allowed_range() {
        assert_eq!(
            line_height_layout(20, 0.5),
            line_height_layout(20, LINE_HEIGHT_MIN)
        );
        assert_eq!(
            line_height_layout(20, -3.0),
            line_height_layout(20, LINE_HEIGHT_MIN)
        );
        assert_eq!(
            line_height_layout(20, 9.0),
            line_height_layout(20, LINE_HEIGHT_MAX)
        );
        assert_eq!(
            line_height_layout(20, f32::INFINITY),
            line_height_layout(20, LINE_HEIGHT_MAX)
        );
        assert_eq!(
            line_height_layout(20, f32::NAN),
            line_height_layout(20, LINE_HEIGHT_MIN)
        );
        assert_eq!(line_height_layout(20, LINE_HEIGHT_MAX).cell_height, 40);
    }
}
