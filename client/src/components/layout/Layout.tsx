import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowLeft, faHouse } from "@fortawesome/free-solid-svg-icons";
import { Outlet, useNavigate } from "react-router-dom";
import style from "./layout.module.css";

const Layout = () => {
    const navigate = useNavigate();

    return (
        <>
            <nav className={style.topNav}>
                <button className={style.navButton} onClick={() => navigate(-1)}>
                    <FontAwesomeIcon icon={faArrowLeft} /> Back
                </button>
                <button className={style.navButton} onClick={() => navigate("/")}>
                    <FontAwesomeIcon icon={faHouse} /> Home
                </button>
            </nav>
            <main className={style.content}>
                <Outlet />
            </main>
        </>
    );
};

export default Layout;
