import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import AuthGate from "./components/AuthGate";
import RequireScreen from "./components/RequireScreen";
import Home from "./pages/Home";
import ContractsList from "./pages/ContractsList";
import ContractDetail from "./pages/ContractDetail";
import CompaniesList from "./pages/CompaniesList";
import CompanyDetail from "./pages/CompanyDetail";
import PersonsList from "./pages/PersonsList";
import PersonDetail from "./pages/PersonDetail";
import AccountsList from "./pages/AccountsList";
import AccountDetail from "./pages/AccountDetail";
import CtiCallDetail from "./pages/CtiCallDetail";
import Cti from "./pages/Cti";
import Billing from "./pages/Billing";
import Review from "./pages/Review";
import ReviewDetail from "./pages/ReviewDetail";
import Litigation from "./pages/Litigation";
import LitigationDetail from "./pages/LitigationDetail";
import Files from "./pages/Files";
import Originals from "./pages/Originals";
import DocTemplates from "./pages/DocTemplates";
import DocMerge from "./pages/DocMerge";
import DocGenerated from "./pages/DocGenerated";
import Household from "./pages/Household";
import Admin from "./pages/Admin";

export default function App() {
  return (
    <AuthGate>
      <Layout>
        <Routes>
        <Route path="/" element={<RequireScreen perm="screen.home"><Home /></RequireScreen>} />
        <Route path="/contracts" element={<RequireScreen perm="screen.contracts"><ContractsList /></RequireScreen>} />
        <Route path="/contracts/:id" element={<RequireScreen perm={["screen.contracts", "screen.billing", "screen.review", "screen.litigation"]}><ContractDetail /></RequireScreen>} />
        <Route path="/billing" element={<RequireScreen perm="screen.billing"><Billing /></RequireScreen>} />
        <Route path="/review" element={<RequireScreen perm="screen.review"><Review /></RequireScreen>} />
        <Route path="/review/:id" element={<RequireScreen perm="screen.review"><ReviewDetail /></RequireScreen>} />
        <Route path="/companies" element={<RequireScreen perm={["screen.companies", "screen.contracts"]}><CompaniesList /></RequireScreen>} />
        <Route path="/companies/:id" element={<RequireScreen perm={["screen.companies", "screen.contracts"]}><CompanyDetail /></RequireScreen>} />
        <Route path="/persons" element={<RequireScreen perm={["screen.persons", "screen.contracts"]}><PersonsList /></RequireScreen>} />
        <Route path="/persons/:id" element={<RequireScreen perm={["screen.persons", "screen.contracts"]}><PersonDetail /></RequireScreen>} />
        <Route path="/accounts" element={<RequireScreen perm={["screen.accounts", "screen.contracts"]}><AccountsList /></RequireScreen>} />
        <Route path="/accounts/:id" element={<RequireScreen perm={["screen.accounts", "screen.contracts"]}><AccountDetail /></RequireScreen>} />
        <Route path="/cti" element={<RequireScreen perm="screen.cti"><Cti /></RequireScreen>} />
        <Route path="/cti/:id" element={<RequireScreen perm="screen.cti"><CtiCallDetail /></RequireScreen>} />
        <Route path="/litigation" element={<RequireScreen perm={["screen.litigation", "screen.contracts"]}><Litigation /></RequireScreen>} />
        <Route path="/litigation/:id" element={<RequireScreen perm={["screen.litigation", "screen.contracts"]}><LitigationDetail /></RequireScreen>} />
        <Route path="/files" element={<RequireScreen perm={["screen.files", "screen.contracts"]}><Files /></RequireScreen>} />
        <Route path="/originals" element={<RequireScreen perm={["screen.originals", "screen.contracts"]}><Originals /></RequireScreen>} />
        <Route path="/doc-templates" element={<RequireScreen perm={["screen.documents", "screen.contracts"]}><DocTemplates /></RequireScreen>} />
        <Route path="/doc-merge/:templateId" element={<RequireScreen perm={["screen.documents", "screen.contracts"]}><DocMerge /></RequireScreen>} />
        <Route path="/doc-generated" element={<RequireScreen perm={["screen.documents", "screen.contracts"]}><DocGenerated /></RequireScreen>} />
        <Route path="/household" element={<RequireScreen perm="screen.household"><Household /></RequireScreen>} />
        <Route path="/admin" element={<RequireScreen adminOnly><Admin /></RequireScreen>} />
      </Routes>
      </Layout>
    </AuthGate>
  );
}
