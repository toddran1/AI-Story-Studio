export class ShutdownController {
  private requested = false;
  request(): void { this.requested = true; }
  get isRequested(): boolean { return this.requested; }
}
