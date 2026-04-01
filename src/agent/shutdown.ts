export class ShutdownController {
  private draining = false;

  beginDrain() {
    this.draining = true;
  }

  isDraining() {
    return this.draining;
  }
}
