// ============================================================================
// Kaeno — Off-Thread Web Worker Conversion Engine
// Pure Native Browser APIs: ImageBitmap, OffscreenCanvas, Blob
// Zero External Libraries · Full-Resolution Guarantee · Zero Cropping
// ============================================================================

const WEBP_MAX_DIMENSION = 16383;
const SAFE_GPU_MAX_DIMENSION = 8192;

self.onmessage = async (e) => {
  const { id, blob, quality } = e.data;

  try {
    self.postMessage({
      type: 'progress',
      id,
      stage: 'Reading full-resolution image...',
      percent: 15
    });

    if (typeof OffscreenCanvas === 'undefined') {
      throw new Error('OffscreenCanvas not supported in worker');
    }

    // 1. Decode bitmap directly to determine verified native dimensions
    let bitmap = await createImageBitmap(blob);
    const nativeWidth = bitmap.width;
    const nativeHeight = bitmap.height;

    if (!nativeWidth || !nativeHeight) {
      bitmap.close();
      throw new Error('Could not read image dimensions');
    }

    let targetW = nativeWidth;
    let targetH = nativeHeight;
    let wasScaled = false;
    let scaleReason = '';

    // WebP specification bitstream limit: maximum 16,383 × 16,383 pixels
    if (targetW > WEBP_MAX_DIMENSION || targetH > WEBP_MAX_DIMENSION) {
      const scale = Math.min(WEBP_MAX_DIMENSION / targetW, WEBP_MAX_DIMENSION / targetH);
      targetW = Math.max(1, Math.floor(targetW * scale));
      targetH = Math.max(1, Math.floor(targetH * scale));
      wasScaled = true;
      scaleReason = `Preserved at ${targetW} × ${targetH} (WebP 16,383px format limit)`;

      // Re-decode with proportional high-quality bicubic downscaling
      bitmap.close();
      bitmap = await createImageBitmap(blob, {
        resizeWidth: targetW,
        resizeHeight: targetH,
        resizeQuality: 'high'
      });
    }

    self.postMessage({
      type: 'progress',
      id,
      stage: `Rendering full frame (${targetW} × ${targetH})...`,
      percent: 50
    });

    let canvas = null;
    let ctx = null;

    try {
      canvas = new OffscreenCanvas(targetW, targetH);
      ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) throw new Error('Could not obtain 2D canvas context');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // Draw 100% of the image from edge to edge — zero cropping
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    } catch (allocErr) {
      // GPU texture budget recovery: clamp proportionally to hardware ceiling
      const safeScale = Math.min(SAFE_GPU_MAX_DIMENSION / nativeWidth, SAFE_GPU_MAX_DIMENSION / nativeHeight);
      targetW = Math.max(1, Math.floor(nativeWidth * safeScale));
      targetH = Math.max(1, Math.floor(nativeHeight * safeScale));
      wasScaled = true;
      scaleReason = `Adapted to device GPU budget (${targetW} × ${targetH})`;

      bitmap.close();
      bitmap = await createImageBitmap(blob, {
        resizeWidth: targetW,
        resizeHeight: targetH,
        resizeQuality: 'high'
      });

      canvas = new OffscreenCanvas(targetW, targetH);
      ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) throw new Error('Could not obtain 2D canvas context');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    } finally {
      bitmap.close(); // Immediate memory release
    }

    self.postMessage({
      type: 'progress',
      id,
      stage: 'Encoding high-fidelity WebP...',
      percent: 85
    });

    if (!canvas || !canvas.convertToBlob) {
      throw new Error('canvas.convertToBlob is not supported');
    }

    const encodedBlob = await canvas.convertToBlob({
      type: 'image/webp',
      quality: quality || 0.95
    });

    canvas.width = 0;
    canvas.height = 0;

    if (!encodedBlob || encodedBlob.size === 0) {
      throw new Error('WebP encoding produced empty output');
    }

    self.postMessage({
      type: 'complete',
      id,
      webpBlob: encodedBlob,
      width: targetW,
      height: targetH,
      wasScaled,
      scaleReason
    });
  } catch (err) {
    self.postMessage({
      type: 'error',
      id,
      message: err.message || 'Worker conversion failed'
    });
  }
};
