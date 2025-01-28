import { InputComponent } from "@/components/inputComponent";

const Home = () => {
  return (
    <main className="min-h-screen grid place-items-center bg-black-pattern">
      <div className="bg-white rounded-3xl py-5 px-4 lg:px-6 w-[85%] lg:w-[30%] flex flex-col items-center">
        <InputComponent />
      </div>
    </main>
  );
};

export default Home;
