// Compare complete provider layouts, never the records on one vertical page.
export async function prepareScaledQuery(provider, input, createLayout, { optimize = true, isCurrent = () => true } = {}) {
  const adaptive = input.scaleMode === 'adaptive' && optimize;
  const limit = input.ratio ?? 4;
  if (!Number.isFinite(limit) || limit < 1 || limit > 32) throw new RangeError('Local scale ratio must be 1 to 32');
  // Keep the legacy 4x density emphasis unless stronger scaling saves rows.
  const ratios = adaptive ? [...new Set([Math.min(4, limit), 8, 16, limit].filter(value => value <= limit))].sort((a, b) => a - b) : [limit];
  const retained = new Set();
  const release = async id => { await provider.releaseQuery(id).catch(() => {}); retained.delete(id); };
  let best = null, baseline = null, layoutError = null, candidate = null;
  const prepare = async ratio => {
    if (candidate) { await release(candidate.query.queryId); candidate = null; }
    if (!isCurrent()) return null;
    const query = await provider.createQuery({ ...input, ratio });
    retained.add(query.queryId);
    if (!isCurrent()) return null;
    const map = await provider.getMap(query.queryId, query.mapId);
    if (!isCurrent()) return null;
    const layout = await createLayout(query, map);
    candidate = { query, map, layout };
    return candidate;
  };
  try {
    for (const ratio of ratios) {
      if (!isCurrent()) return null;
      try { await prepare(ratio); }
      catch (error) {
        if (['row_payload_limit', 'label_width_limit'].includes(error.code)) {
          layoutError = error;
          for (const id of retained) await release(id);
          continue;
        }
        throw error;
      }
      if (!isCurrent()) return null;
      const { query, layout } = candidate;
      // Stop comparing when live data changes; publish one coherent fresh layout.
      if (best && (query.generation !== best.generation || query.revision !== best.revision)) {
        best = { ratio, totalRows: layout.totalRows, generation: query.generation, revision: query.revision };
        baseline = layout.totalRows;
        break;
      }
      baseline ??= layout.totalRows;
      if (!best || layout.totalRows < best.totalRows) best = { ratio, totalRows: layout.totalRows, generation: query.generation, revision: query.revision };
      if (query.coverage?.complete === false) break;
      if (best.totalRows <= 1 || layout.detailTotal === 0) break;
    }
    if (!isCurrent()) return null;
    if (!best) throw layoutError;
    // Local admits two queries: keep the displayed query, recycle each probe,
    // and reprepare the winner once when it was not the last candidate.
    if (candidate?.map.ratio !== best.ratio) await prepare(best.ratio);
    if (!isCurrent()) return null;
    if (candidate.query.generation !== best.generation || candidate.query.revision !== best.revision) baseline = candidate.layout.totalRows;
    retained.delete(candidate.query.queryId);
    return { ...candidate, baselineRows: baseline };
  } finally {
    for (const id of retained) await release(id);
  }
}
