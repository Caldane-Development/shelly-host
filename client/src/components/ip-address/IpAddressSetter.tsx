import { useDispatch, useSelector } from "react-redux";
import { useState } from "react";
import { requestScan, setIpAddress } from "../../store/scannerSlice";
import { RootState } from "../../store/store";

const ALL_RANGES = "__all__";

const IpAddressSetter = () => {
  const dispatch = useDispatch();
  const networks = useSelector((state: RootState) => state.scanner.networks);
  const [selected, setSelected] = useState("");

  // Collapse networks that share the same /24 so "All ranges" doesn't scan the
  // same subnet twice.
  const uniqueRanges = (ips: string[]): string[] => {
    const seen = new Set<string>();
    return ips.filter((ip) => {
      const prefix = ip.split(".").slice(0, 3).join(".");
      if (seen.has(prefix)) return false;
      seen.add(prefix);
      return true;
    });
  };

  const resolveTargets = (): string[] => {
    if (selected === ALL_RANGES) return uniqueRanges(networks);
    if (selected) return [selected];
    return [];
  };

  const targets = resolveTargets();
  const canScan = targets.length > 0;

  const handleScan = () => {
    if (!canScan) return;
    if (targets.length === 1) {
      dispatch(setIpAddress(targets[0]));
    }
    dispatch(requestScan(targets));
  };

  return (
    <section>
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
      >
        <option value="" disabled>
          Select a network
        </option>
        {networks.length > 0 && <option value={ALL_RANGES}>All ranges</option>}
        {networks.map((network) => (
          <option key={network} value={network}>
            {network}
          </option>
        ))}
      </select>
      <button type="button" onClick={handleScan} disabled={!canScan}>
        Scan
      </button>
    </section>
  );
};

export default IpAddressSetter;
