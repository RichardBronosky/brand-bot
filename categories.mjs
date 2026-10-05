// Normalize the recursive contact tree once at build time. Legacy configs keep
// their labels, order and routes; a categories array explicitly replaces them.
export function categoriesFor(config) {
  const input = config.categories !== undefined ? config.categories : [
    { ...config.professional, id: 'professional', label: config.professional?.label || 'Professional', icon: config.professional?.icon || '💼' },
    { ...config.personal, id: 'personal', label: config.personal?.label || 'Personal', icon: config.personal?.icon || '🌻' },
  ];
  if (!Array.isArray(input) || (config.categories !== undefined && !input.length)) throw new Error('categories must be a non-empty array');
  function normalize(nodes, parentIds = [], parentLabels = []) {
    const used = new Set();
    return nodes.map((node) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Each category must be an object');
      if (typeof node.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(node.id)) throw new Error('Each category needs a stable lowercase id (letters, numbers, _ or -)');
      if ((!parentIds.length && ['meet', 'qr', 'owner'].includes(node.id)) || used.has(node.id)) throw new Error('Duplicate or reserved category id: ' + node.id);
      used.add(node.id);
      if (typeof node.label !== 'string' || !node.label.trim()) throw new Error('Each category needs a label');
      if (node.links !== undefined && !Array.isArray(node.links)) throw new Error('Category links must be an array');
      if (node.categories !== undefined && !Array.isArray(node.categories)) throw new Error('Nested categories must be an array');
      const ids = [...parentIds, node.id], labels = [...parentLabels, node.label];
      const links = (node.links || []).map((link) => {
        if (!link || typeof link !== 'object' || typeof link.label !== 'string' || !link.label.trim()) throw new Error('Each contact link needs a label');
        return { ...link, path: [...labels, link.label], categoryIds: ids };
      });
      return { id: node.id, label: node.label, icon: node.icon || '🔗', blurb: node.blurb || '', ids, labels, links,
        categories: normalize(node.categories || [], ids, labels) };
    });
  }
  return normalize(input);
}
export function allCategories(nodes) {
  return nodes.flatMap((node) => [node, ...allCategories(node.categories)]);
}
export function allLinks(nodes) { return allCategories(nodes).flatMap((node) => node.links); }
