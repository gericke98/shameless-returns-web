import { InputComponent } from "./components/inputComponent";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-black-pattern">
      <div className="bg-white flex flex-col lg:w-[30%] w-[85%] rounded-3xl items-center py-5 lg:px-6 px-4">
        <InputComponent />
      </div>
    </main>
  );
}
