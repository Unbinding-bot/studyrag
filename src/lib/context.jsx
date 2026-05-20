import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { getAllSettings, putSetting } from "./db.js";
import { DEFAULT_SETTINGS, ALL_THEMES } from "./themes.js";

const AppCtx = createContext(null);

export function AppProvider({ children }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getAllSettings().then((s) => {
      setSettings({ ...DEFAULT_SETTINGS, ...s });
      setLoaded(true);
    });
  }, []);

  const saveSetting = useCallback(async (key, value) => {
    setSettings((p) => ({ ...p, [key]: value }));
    await putSetting(key, value);
  }, []);

  const saveSettings = useCallback(async (patch) => {
    setSettings((p) => ({ ...p, ...patch }));
    await Promise.all(Object.entries(patch).map(([k, v]) => putSetting(k, v)));
  }, []);

  const theme = ALL_THEMES.find((t) => t.id === settings.colorTheme) || ALL_THEMES[0];

  return (
    <AppCtx.Provider value={{ settings, saveSetting, saveSettings, theme, loaded }}>
      {children}
    </AppCtx.Provider>
  );
}

export const useApp = () => useContext(AppCtx);
