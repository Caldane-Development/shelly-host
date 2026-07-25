import { useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlus, faTrash } from "@fortawesome/free-solid-svg-icons";
import style from "./site-configs.module.css";
import { RootState } from "../../store/store";
import { addNetwork, removeNetwork } from "../../store/scannerSlice";

// IPv4 regex (accepts any valid IPv4, e.g. a network address like 10.10.9.0)
const ipRegex = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

const SiteConfigs = () => {
    const dispatch = useDispatch();
    const networks = useSelector((state: RootState) => state.scanner.networks);
    const [inputValue, setInputValue] = useState("");
    const [error, setError] = useState("");

    const handleAdd = (e: React.FormEvent) => {
        e.preventDefault();
        const value = inputValue.trim();

        if (!ipRegex.test(value)) {
            setError("Enter a valid IPv4 network address, e.g. 10.10.9.0");
            return;
        }
        if (networks.includes(value)) {
            setError("That network has already been added.");
            return;
        }

        dispatch(addNetwork(value));
        setInputValue("");
        setError("");
    };

    return (
        <section className={style["site-configs"]}>
            <h2>Site Configs</h2>
            <div className={style.panel}>
                <p>Networks the scanner is allowed to scan.</p>

                <form className={style["add-form"]} onSubmit={handleAdd}>
                    <input
                        type="text"
                        placeholder="e.g. 10.10.9.0"
                        value={inputValue}
                        onChange={(e) => {
                            setInputValue(e.target.value);
                            if (error) setError("");
                        }}
                        className={error ? style.invalid : undefined}
                    />
                    <button type="submit">
                        <FontAwesomeIcon icon={faPlus} /> Add
                    </button>
                </form>
                {error && <p className={style.error}>{error}</p>}

                {networks.length === 0 ? (
                    <p className={style.empty}>No networks configured yet.</p>
                ) : (
                    <ul className={style["network-list"]}>
                        {networks.map((network) => (
                            <li key={network}>
                                <span className={style["network-name"]}>{network}</span>
                                <button
                                    className={style.remove}
                                    onClick={() => dispatch(removeNetwork(network))}
                                    aria-label={`Remove ${network}`}
                                >
                                    <FontAwesomeIcon icon={faTrash} />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </section>
    );
};

export default SiteConfigs;
