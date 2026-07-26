import { createSlice, PayloadAction } from "@reduxjs/toolkit";

const NETWORKS_KEY = "scanner.networks";

const loadNetworks = (): string[] => {
  try {
    const raw = localStorage.getItem(NETWORKS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
};

const persistNetworks = (networks: string[]) => {
  try {
    localStorage.setItem(NETWORKS_KEY, JSON.stringify(networks));
  } catch {
    // Ignore persistence errors (e.g. storage disabled)
  }
};

interface ScannerState {
  ipAddress: string;
  networks: string[];
  scanTargets: string[];
  scanId: number;
}

const initialState: ScannerState = {
  ipAddress: "192.168.1.1", // Default or blank
  networks: loadNetworks(),
  scanTargets: [],
  scanId: 0,
};

export const scannerSlice = createSlice({
  name: "scanner",
  initialState,
  reducers: {
    setIpAddress: (state, action: PayloadAction<string>) => {
      state.ipAddress = action.payload;
    },
    addNetwork: (state, action: PayloadAction<string>) => {
      const network = action.payload.trim();
      if (network && !state.networks.includes(network)) {
        state.networks.push(network);
        persistNetworks(state.networks);
      }
    },
    removeNetwork: (state, action: PayloadAction<string>) => {
      state.networks = state.networks.filter((n) => n !== action.payload);
      persistNetworks(state.networks);
    },
    requestScan: (state, action: PayloadAction<string[]>) => {
      state.scanTargets = action.payload;
      state.scanId += 1;
    },
  },
});

export const { setIpAddress, addNetwork, removeNetwork, requestScan } = scannerSlice.actions;
export default scannerSlice.reducer;
