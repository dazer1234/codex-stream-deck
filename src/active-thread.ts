/** Runs in the renderer, where inactive chat composers can remain mounted. */
export function readActiveThreadKey(): string | null {
  const sidebar = document.querySelector('[data-app-action-sidebar-thread-id][data-app-action-sidebar-thread-active="true"]')
    ?? document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]');
  const key = sidebar?.getAttribute('data-app-action-sidebar-thread-id');
  if (key) return key;
  const composer = Array.from(document.querySelectorAll('[data-above-composer-conversation-id]'))
    .find(element => element.getClientRects().length > 0 && !element.closest('[hidden], [aria-hidden="true"]'));
  return composer?.getAttribute('data-above-composer-conversation-id') ?? null;
}
