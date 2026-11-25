/** Per-terminal ownership: which session owns an open terminal and which
 * connection is currently attached to it. A terminal id is only an identifier;
 * authorization comes from this registry plus the authenticated
 * connection/session context. */
export type TerminalOwner = {
  terminalId: string;
  sessionId: string;
  /** `null` when the owning connection has been released but the terminal
   * itself is still alive and can be re-attached from the same session. */
  connectionId: string | null;
};

export class TerminalOwnership {
  private readonly owners = new Map<string, TerminalOwner>();

  claim(terminalId: string, sessionId: string, connectionId: string): void {
    this.owners.set(terminalId, { terminalId, sessionId, connectionId });
  }

  /** Full release: the terminal is being closed and the id must not be reused. */
  release(terminalId: string): void {
    this.owners.delete(terminalId);
  }

  /** Detach the connection binding without destroying session ownership.
   * Returns the terminal ids that were bound to this connection. */
  detachByConnection(connectionId: string): string[] {
    const released: string[] = [];
    for (const [id, owner] of this.owners) {
      if (owner.connectionId === connectionId) {
        this.owners.set(id, { ...owner, connectionId: null });
        released.push(id);
      }
    }
    return released;
  }

  get(terminalId: string): TerminalOwner | undefined {
    return this.owners.get(terminalId);
  }
}
