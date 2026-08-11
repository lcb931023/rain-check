const dict = {
  zh: {
    title: '{city}内涝地图',
    city: '城市',
    drainage: '排水效率',
    drainageHint: '拖动模拟排水系统好坏',
    now: '现在',
    estimated: '过去（估计）',
    predicted: '未来（预测）',
    bandNone: '无明显积水',
    bandPossible: '可能积水',
    bandSevere: '严重积水',
    legendDisclaimer: '模型估算，非实测数据',
    updatedAt: '数据更新于',
    coverage: '数据覆盖',
    loading: '数据加载中…',
    noData: '暂无降雨数据，请稍后刷新',
    reports: '积水报告',
    langToggle: 'EN',
  },
  en: {
    title: '{city} Flood Map',
    city: 'City',
    drainage: 'Drainage efficiency',
    drainageHint: 'Drag to simulate drainage quality',
    now: 'Now',
    estimated: 'Past (estimated)',
    predicted: 'Future (predicted)',
    bandNone: 'No significant water',
    bandPossible: 'Possible flooding',
    bandSevere: 'Severe flooding',
    legendDisclaimer: 'Model estimate, not measurements',
    updatedAt: 'Data updated',
    coverage: 'Coverage',
    loading: 'Loading…',
    noData: 'No rain data yet, refresh later',
    reports: 'Flood reports',
    langToggle: '中文',
  },
} as const;

export type Lang = 'zh' | 'en';
let lang: Lang = (localStorage.getItem('lang') as Lang) || 'zh';
export const getLang = () => lang;
export function setLang(l: Lang) { lang = l; localStorage.setItem('lang', l); }

/** The current city's localized name, substituted into `{city}` by t(). */
let cityName: Record<Lang, string> = { zh: '', en: '' };
export function setCityName(n: Record<Lang, string>) { cityName = n; }

export function t(key: keyof typeof dict['zh']): string {
  return dict[lang][key].replace('{city}', cityName[lang]);
}
