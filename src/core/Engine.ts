import * as THREE from 'three';
import { createSky, HORIZON_COLOR } from './Sky';

/** 視点モード。フォグと画角がここで変わる。 */
export type ViewMode = 'orbit' | 'fp';

/** 太陽の向き。格子軸と揃わない方向。揃えると面の切り替わりが目立つ。 */
const SUN_DIR = new THREE.Vector3(-0.63, 0.72, 0.29).normalize();

/** レンダラ・シーン・カメラ・空・リサイズだけを持つ薄い箱。 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  readonly sun: THREE.DirectionalLight;
  /**
   * 坑内の灯り。一人称で坑道へ入ったときだけ点く。
   *
   * 無いと、自分で掘った坑道の中が本当に真っ暗になる。太陽と半球光しか
   * 無いのだから物理的には正しいが、支保を入れる相手が見えないので
   * 一人称で坑内の仕事ができない。強度を 0 にして常に置いておく
   * (`visible` で消すとライトの本数が変わってシェーダが組み直される)。
   */
  readonly headlamp: THREE.PointLight;
  private sky: THREE.Mesh;

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
    // 影を落とすのは木だけ (地形は 250 チャンクぶんの影を持たない方針)。
    // 木の影があると、一人称で自分がどこに立っているのかが分かる。
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.canvas = this.renderer.domElement;
    container.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(
      55,
      window.innerWidth / window.innerHeight,
      0.2,
      1200,
    );

    this.scene.background = new THREE.Color(HORIZON_COLOR);
    this.scene.fog = new THREE.Fog(HORIZON_COLOR, 180, 460);

    this.sun = this.setupLights();
    this.headlamp = new THREE.PointLight(0xffe6bc, 0, 18, 1.3);
    this.scene.add(this.headlamp);
    this.sky = createSky(SUN_DIR);
    this.scene.add(this.sky);

    window.addEventListener('resize', () => this.onResize());
  }

  private setupLights(): THREE.DirectionalLight {
    // 半球光で全体の底上げ。地形の影は落とさない方針なので、
    // 陰影は法線とアンビエントの差でつける。
    const hemi = new THREE.HemisphereLight(0xbcd4f0, 0x4a3f33, 1.15);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff3e0, 2.1);
    sun.position.copy(SUN_DIR).multiplyScalar(200);
    this.scene.add(sun);
    this.scene.add(sun.target);

    const fill = new THREE.DirectionalLight(0x9fb8d8, 0.45);
    fill.position.set(0.51, 0.33, -0.79).normalize().multiplyScalar(200);
    this.scene.add(fill);
    return sun;
  }

  /**
   * 影の範囲を世界に合わせる。
   *
   * 平行光の影は 1 枚の直交カメラで世界全部を覆う。128 m 四方なら
   * 2048 テクセルで 1 テクセル 8 cm 相当。木の輪郭にはこれで足りる。
   * 動かす予定が無いので、ここで 1 回決めたら以後さわらない。
   */
  configureSun(center: THREE.Vector3, radius: number): void {
    const sun = this.sun;
    sun.position.copy(SUN_DIR).multiplyScalar(radius * 2.2).add(center);
    sun.target.position.copy(center);
    sun.target.updateMatrixWorld();
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 1;
    cam.far = radius * 5;
    cam.updateProjectionMatrix();
    // アクネ対策。法線バイアスのほうが、薄い葉でも縞が出にくい。
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.06;
  }

  /**
   * 視点モードに合わせて画角とフォグを振る。
   *
   * 俯瞰は遠景を見せたいのでフォグは遠く、画角は狭め (地形の形が歪まない)。
   * 一人称は逆で、画角を広げないと足元と前方を同時に見られないし、
   * フォグを手前から効かせないと 100 m 先の尾根までのっぺり見えて距離が読めない。
   */
  setViewMode(mode: ViewMode): void {
    const fog = this.scene.fog as THREE.Fog;
    if (mode === 'fp') {
      this.camera.fov = 72;
      fog.near = 45;
      fog.far = 340;
    } else {
      this.camera.fov = 55;
      fog.near = 180;
      fog.far = 460;
    }
    this.camera.updateProjectionMatrix();
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  render(): void {
    // 空はカメラに貼りついて動く。置き去りにすると内側から抜ける。
    this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }
}
