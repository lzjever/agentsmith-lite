import { Spinner } from "@astryxdesign/core";
import { PageState } from "../../../../../../components/layout/PageState";
export default function Loading() { return <PageState state="loading"><Spinner label="Loading credentials..." /></PageState>; }
