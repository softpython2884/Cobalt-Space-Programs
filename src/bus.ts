// ============ COBALT SECTOR — bus de commandes (solo : direct, multi : réseau) ============
// Toutes les actions de jeu de l'interface passent par ici. En solo, elles
// s'exécutent immédiatement sur l'état local ; en multijoueur, elles partent
// au serveur qui les valide et les applique dans la simulation autoritaire.

export type CmdExec = (name: string, args: Record<string, unknown>) => string | null;

let impl: CmdExec = () => 'Aucune partie en cours';

export function setCmdExec(f: CmdExec) { impl = f; }
export function cmd(name: string, args: Record<string, unknown> = {}): string | null {
  return impl(name, args);
}
