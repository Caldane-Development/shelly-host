import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowLeft, faHouse } from "@fortawesome/free-solid-svg-icons";
import { Outlet, useNavigate } from "react-router-dom";

const Layout = () => {
    const navigate = useNavigate();

    return (
        <>
            <nav>
                <button onClick={() => navigate(-1)}>
                    <FontAwesomeIcon icon={faArrowLeft} /> Back
                </button>
                <button onClick={() => navigate("/")}>
                    <FontAwesomeIcon icon={faHouse} /> Home
                </button>
            </nav>
            <Outlet />
        </>
    );
};

export default Layout;
