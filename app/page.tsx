import { InputComponent } from "./components/inputComponent";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-black-pattern">
      <div className="bg-white flex flex-col lg:w-[30%] rounded-3xl items-center py-5 px-10">
        <InputComponent />
      </div>
    </main>
  );
}
