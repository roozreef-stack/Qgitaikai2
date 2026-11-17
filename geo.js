'use strict';

// 距離・方位計算、位置情報・向きの取得
const EARTH_RADIUS_M = 6371000;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

const Geo = {
  // ---------- 計算 ----------
  // 0〜360度に正規化
  normalizeDeg(deg) {
    return ((deg % 360) + 360) % 360;
  },

  // ハーバーサイン距離（m）
  distance(lat1, lng1, lat2, lng2) {
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
  },

  // 地点1から地点2への方位角（北=0、時計回り、0〜360度）
  bearing(lat1, lng1, lat2, lng2) {
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δλ = toRad(lng2 - lng1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return Geo.normalizeDeg(toDeg(Math.atan2(y, x)));
  },

  // ---------- 位置情報 ----------
  isSupported() {
    return 'geolocation' in navigator;
  },

  // 1回だけ取得（スタート時の許可取得に使う）
  getCurrentPosition() {
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0,
      });
    });
  },

  // 継続して取得。戻り値の関数を呼ぶと停止する
  watchPosition(onPosition, onError) {
    const id = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 0,
    });
    return () => navigator.geolocation.clearWatch(id);
  },

  // ---------- 端末の向き ----------
  // iOSでは許可が必要。必ずタップ操作の中で（await より前に）呼ぶこと
  // 戻り値：'granted' | 'denied'（許可不要な端末は 'granted'）
  requestOrientationPermission() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      return DOE.requestPermission().catch(() => 'denied');
    }
    return Promise.resolve('granted');
  },

  // 向き（北=0、時計回り）を受け取り続ける。戻り値の関数を呼ぶと停止する
  //   iOS：webkitCompassHeading
  //   Android：deviceorientationabsolute の 360 - alpha。非対応なら deviceorientation で代替
  watchHeading(onHeading) {
    let gotAbsolute = false;

    // 画面を横にしたときの補正（縦持ちなら0）
    const screenAngle = () => {
      if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
      return typeof window.orientation === 'number' ? window.orientation : 0;
    };
    const emit = (deg) => onHeading(Geo.normalizeDeg(deg + screenAngle()));

    const onAbsolute = (e) => {
      if (e.alpha == null) return;
      gotAbsolute = true;
      emit(360 - e.alpha);
    };
    const onRelative = (e) => {
      if (typeof e.webkitCompassHeading === 'number') {
        // iOS。精度が負の値なら較正されていないので使わない
        if (e.webkitCompassAccuracy < 0) return;
        emit(e.webkitCompassHeading);
        return;
      }
      // deviceorientationabsolute が来ない端末の代替。
      // alpha が北基準（absolute）のときだけ使う。そうでない alpha は向きの基準が不定で、矢印が誤った方向を指すため
      if (!gotAbsolute && e.absolute === true && e.alpha != null) emit(360 - e.alpha);
    };

    const hasAbsolute = 'ondeviceorientationabsolute' in window;
    if (hasAbsolute) window.addEventListener('deviceorientationabsolute', onAbsolute);
    window.addEventListener('deviceorientation', onRelative);
    return () => {
      if (hasAbsolute) window.removeEventListener('deviceorientationabsolute', onAbsolute);
      window.removeEventListener('deviceorientation', onRelative);
    };
  },

  // GeolocationPositionError → 画面に出す文
  positionErrorMessage(err) {
    switch (err && err.code) {
      case 1: return '位置情報の利用が許可されていません。';
      case 2: return '現在地を特定できません。屋外の空が見える場所で、端末の位置情報サービスがオンになっているか確認してください。';
      case 3: return '位置情報の取得に時間がかかっています。しばらくお待ちください。';
      default: return '位置情報を取得できませんでした。';
    }
  },
};
