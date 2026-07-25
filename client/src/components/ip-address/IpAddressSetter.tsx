import { useDispatch, useSelector } from "react-redux";
import { useState } from "react";
import { setIpAddress } from "../../store/scannerSlice";
import { RootState } from "../../store/store";

const IpAddressSetter = () => {
  const dispatch = useDispatch();
  const networks = useSelector((state: RootState) => state.scanner.networks);
  const ipAddress = useSelector((state: RootState) => state.scanner.ipAddress);
  const [inputValue, setInputValue] = useState("");

  // IPv4 regex
  const ipRegex = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.trim();
    setInputValue(value);

    if (ipRegex.test(value)) {
      dispatch(setIpAddress(value));
    }
  };

  return (
    <section>
      {networks.length > 0 && (
        <select
          value={networks.includes(ipAddress) ? ipAddress : ""}
          onChange={(e) => dispatch(setIpAddress(e.target.value))}
        >
          <option value="" disabled>
            Select a network
          </option>
          {networks.map((network) => (
            <option key={network} value={network}>
              {network}
            </option>
          ))}
        </select>
      )}
      <input
        type="text"
        placeholder="Enter IP Address"
        value={inputValue}
        onChange={handleChange}
      />
    </section>
  );
};

export default IpAddressSetter;
