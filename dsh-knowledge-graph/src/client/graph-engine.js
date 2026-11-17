/**
 * Cytoscape plus the fcose force-directed layout.
 *
 * `cytoscape.use(fcose)` registers a layout extension globally, so it runs once
 * from the plugin's apply function (and once more from the panel effect as a
 * harmless guard for a standalone mount).
 */
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';

let registered = false;

/** Register fcose once and return the shared cytoscape factory. */
export function ensureFcose() {
  if (!registered) {
    cytoscape.use(fcose);
    registered = true;
  }
  return cytoscape;
}

export { cytoscape };
