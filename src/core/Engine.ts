import * as THREE from 'three';

/** レンダラ・シーン・カメラ・リサイズだけを持つ薄い箱。 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.canvas = this.renderer.domElement;
    container.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(
      55,
      window.innerWidth / window.innerHeight,
      0.2,
      1200,
    );

    this.scene.background = new THREE.Color(0x8fa6bd);
    this.scene.fog = new THREE.Fog(0x8fa6bd, 180, 460);

    this.setupLights();

    window.addEventListener('resize', () => this.onResize());
  }

  private setupLights(): void {
    // 半球光で全体の底上げ。地形の影は落とさない方針なので、
    // 陰影は法線とアンビエントの差でつける。
    const hemi = new THREE.HemisphereLight(0xbcd4f0, 0x4a3f33, 1.15);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff3e0, 2.1);
    // 格子軸と揃わない方向にする。軸に揃えると面の切り替わりが目立つ。
    sun.position.set(-0.63, 0.72, 0.29).normalize().multiplyScalar(200);
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0x9fb8d8, 0.45);
    fill.position.set(0.51, 0.33, -0.79).normalize().multiplyScalar(200);
    this.scene.add(fill);
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
