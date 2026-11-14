export function summarize(bytes, mediaType) {
  if (mediaType.includes('application/json')) {
    try {
      const value = JSON.parse(bytes);
      if (value.deliveryId && Array.isArray(value.roots)) return { format: 'delivery-index', deliveryId: value.deliveryId, roots: value.roots.length };
    } catch {}
  }
  try { const value = JSON.parse(bytes); return { format: 'source-map', version: value.version || null, sections: value.sections?.length || 0 }; } catch { return { format: 'source-text', byteLength: bytes.length }; }
}
